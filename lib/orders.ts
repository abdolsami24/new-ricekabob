// Shared order side-effects: the single place where an order becomes
// paid / test_paid. Used by the Stripe webhook and by /api/test-pay.
// Idempotent: an order that is already paid is never processed twice.

import { getServiceClient } from "./supabase/server";
import { notifyOwner, type NotifyOrder } from "./email";
import type { ShipdayOrder } from "./shipday";
import { dispatchShipdayForOrder } from "./shipday";
import { dispatchDeliveryForOrder, getDeliverySettings, registerHouseDelivery } from "./delivery";
import { smsOrderConfirmed } from "./sms";
import { sendOrderToFreshKds } from "./freshkds";
import { earnPointsForPaidOrder } from "./points";

export type OrderRow = NotifyOrder &
  ShipdayOrder & {
    kitchen_status: string;
    stripe_session_id: string | null;
    shipday_status: string | null;
    created_at: string;
    // Stage 3 (DoorDash) — optional because the columns arrive with
    // supabase/stage3-schema.sql; absent on a not-yet-migrated DB.
    delivery_provider?: string | null;
    delivery_external_id?: string | null;
    delivery_status?: string | null;
    delivery_quote_id?: string | null;
    delivery_error?: string | null;
    delivery_markup_cents?: number;
    // Service Fee + Free Delivery — optional because the columns
    // arrive with supabase/service-fee-promo-schema.sql.
    service_fee_cents?: number;
    free_delivery?: boolean;
    // Fresh KDS — optional because the columns arrive with
    // supabase/freshkds-schema.sql; absent on a not-yet-migrated DB.
    scheduled_for?: string | null;
    // Curbside — optional because the columns arrive with
    // supabase/curbside-schema.sql; absent on a not-yet-migrated DB.
    car_description?: string | null;
    customer_here_at?: string | null;
    // House Delivery — optional because the column arrives with
    // supabase/house-delivery-schema.sql; absent before it runs.
    driver_token?: string | null;
    // Order-level checkout note rides along via NotifyOrder (lib/email)
    // — optional because the column arrives with
    // supabase/order-note-schema.sql. getOrder's select("*") picks it
    // up when present and omits it before, so markOrderPaid passes it
    // to the owner email fail-softly with no extra handling here.
    freshkds_status?: string | null;
    freshkds_error?: string | null;
    freshkds_sent_at?: string | null;
  };

export async function getOrder(orderId: number): Promise<OrderRow | null> {
  const supabase = getServiceClient();
  const { data, error } = await supabase
    .from("orders")
    .select("*")
    .eq("id", orderId)
    .maybeSingle();
  if (error) throw error;
  return (data as OrderRow) ?? null;
}

/**
 * Marks an unpaid order as paid/test_paid, then fires the owner email,
 * the customer confirmation SMS, and (for delivery orders) the
 * DoorDash Drive dispatch. Side-effect failures are recorded
 * or logged, never thrown back at the payment flow.
 */
export async function markOrderPaid(
  orderId: number,
  status: "paid" | "test_paid"
): Promise<{ order: OrderRow; alreadyPaid: boolean }> {
  const supabase = getServiceClient();
  const order = await getOrder(orderId);
  if (!order) throw new Error(`Order ${orderId} not found`);
  if (order.payment_status === "paid" || order.payment_status === "test_paid") {
    return { order, alreadyPaid: true };
  }
  const { data, error } = await supabase
    .from("orders")
    .update({ payment_status: status })
    .eq("id", orderId)
    .eq("payment_status", "unpaid")
    .select("*")
    .maybeSingle();
  if (error) throw error;
  const updated = (data as OrderRow) ?? { ...order, payment_status: status };

  // AUTO-ACCEPT (one-tap kitchen flow, 2026-11-18): a paid order is
  // "Accepted" the moment payment lands — no staff action. Only a
  // still-'new' order is flipped, and because this whole block runs
  // only on the unpaid -> paid transition above, it happens exactly
  // once per order. Best-effort: the kitchen feed also presents any
  // paid in-progress order as Accepted, so a failure here can never
  // strand an order in the old flow.
  try {
    const { data: ks } = await supabase
      .from("orders")
      .update({ kitchen_status: "accepted" })
      .eq("id", orderId)
      .eq("kitchen_status", "new")
      .select("id")
      .maybeSingle();
    if (ks) updated.kitchen_status = "accepted";
  } catch (err) {
    console.error("[orders] auto-accept failed:", err);
  }

  // Loyalty: award points to the signed-in customer (best-effort,
  // idempotent — re-running the webhook never double-awards).
  try {
    await earnPointsForPaidOrder(updated);
  } catch (err) {
    console.error("[orders] loyalty earn failed:", err);
  }

  // Owner email (best-effort).
  try {
    await notifyOwner(updated);
  } catch (err) {
    console.error("[orders] owner notification failed:", err);
  }

  // Delivery dispatch for delivery orders, via the ACTIVE provider
  // (Admin → Operations → Delivery; default DoorDash Drive).
  // DoorDash (Stage 3): best-effort and idempotent — a failure leaves
  // the order PAID with delivery_status 'pending' + delivery_error
  // for the admin Retry button; it never fails the customer's payment.
  // Shipday (provider switch): flat-fee dispatch via lib/shipday.ts;
  // test orders are never really sent (Shipday has no sandbox).
  if (updated.fulfillment === "delivery") {
    try {
      const deliverySettings = await getDeliverySettings();
      // The provider was FIXED at checkout (from the verified stored
      // quote) and saved on the order — it wins over the current
      // settings, so flipping a switch later never reroutes an order
      // that was already placed. Orders from before the House
      // Delivery update have no provider saved and fall back to the
      // settings exactly as before.
      const orderProvider = updated.delivery_provider ?? null;
      if (orderProvider === "house") {
        await registerHouseDelivery(updated);
      } else if (orderProvider === "shipday") {
        await dispatchShipdayForOrder(updated);
      } else if (orderProvider === "doordash") {
        await dispatchDeliveryForOrder(updated);
      } else if (deliverySettings.provider === "shipday") {
        await dispatchShipdayForOrder(updated);
      } else {
        await dispatchDeliveryForOrder(updated);
      }
      const fresh = await getOrder(orderId).catch(() => null);
      if (fresh) {
        updated.delivery_provider = fresh.delivery_provider;
        updated.delivery_external_id = fresh.delivery_external_id;
        updated.delivery_status = fresh.delivery_status;
        updated.delivery_error = fresh.delivery_error;
        updated.shipday_order_id = fresh.shipday_order_id;
        updated.shipday_status = fresh.shipday_status;
      }
    } catch (err) {
      console.error("[orders] delivery dispatch failed:", err);
    }
  }

  // Fresh KDS kitchen screens (best-effort; complete no-op until
  // FRESHKDS_TOKEN is set in Vercel). Runs only on the unpaid -> paid
  // transition, like every side-effect here, so each order is sent
  // exactly once; the result is recorded on the order for the admin
  // panel and a failure never touches the payment flow. Placed after
  // the DoorDash block so a delivery order's external id is known.
  try {
    await sendOrderToFreshKds(updated);
  } catch (err) {
    console.error("[orders] Fresh KDS send failed:", err);
  }

  // Customer confirmation SMS (best-effort; no-op until Twilio is
  // configured in Vercel).
  try {
    await smsOrderConfirmed(updated);
  } catch (err) {
    console.error("[orders] confirmation SMS failed:", err);
  }

  return { order: updated, alreadyPaid: false };
}
