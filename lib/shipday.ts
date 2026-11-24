// Shipday delivery dispatch.
// Customers order and pay ONLY on this website — no marketplace commission.
// When a delivery order is really PAID and Shipday is the active
// delivery provider (Admin → Operations → Delivery), the server sends
// it to Shipday, which assigns a driver (Sami's own driver or an
// on-demand one) for a flat per-delivery fee on his Shipday account.
// TEST SAFETY: Shipday has no sandbox, so test_paid orders — and any
// order while the board test-mode flag is on — are NEVER sent; they
// record shipday_status 'test mode — not sent' instead.
// Dispatch is best-effort: a Shipday failure never fails the customer's order.

import { getServiceClient } from "./supabase/server";

export interface ShipdayOrder {
  id: number;
  customer_name: string | null;
  customer_phone: string | null;
  delivery_address: string | null;
  items_json: {
    id: string;
    name: string;
    qty: number;
    unit_price_cents: number;
    line_total_cents: number;
  }[];
  tax_cents: number;
  total_cents: number;
  shipday_order_id: string | null;
}

export function shipdayConfigured(): boolean {
  return Boolean(process.env.SHIPDAY_API_KEY);
}

/** Normalizes a US phone number to +1 form for Shipday. */
export function normalizePhone(phone: string): string {
  const digits = (phone || "").replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return phone;
}

export async function dispatchToShipday(
  order: ShipdayOrder
): Promise<{ ok: boolean; shipday_order_id?: string; status: string }> {
  if (order.shipday_order_id) {
    return { ok: true, shipday_order_id: order.shipday_order_id, status: "already sent" };
  }
  if (!shipdayConfigured()) {
    return { ok: false, status: "not sent — Shipday key not configured" };
  }
  try {
    const res = await fetch("https://api.shipday.com/orders", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // Shipday expects the RAW api key after "Basic" (not base64).
        Authorization: `Basic ${process.env.SHIPDAY_API_KEY}`,
      },
      body: JSON.stringify({
        orderNumber: String(order.id),
        customerName: order.customer_name ?? "Customer",
        customerAddress: order.delivery_address ?? "",
        customerPhoneNumber: normalizePhone(order.customer_phone ?? ""),
        restaurantName: "Madinah Market",
        restaurantAddress: "3126 S Parker Rd, Aurora, CO 80014, USA",
        orderItem: (order.items_json ?? []).map((l) => ({
          name: l.name,
          unitPrice: l.unit_price_cents / 100,
          quantity: l.qty,
        })),
        tax: order.tax_cents / 100,
        totalOrderCost: order.total_cents / 100,
        deliveryInstruction: "Please deliver to the address on this order.",
        orderSource: "Madinah Market website",
        paymentMethod: "credit_card",
      }),
    });
    const data = (await res.json().catch(() => ({}))) as {
      success?: boolean;
      orderId?: number | string;
      response?: string;
    };
    if (res.ok && data && (data.success || data.orderId)) {
      return {
        ok: true,
        shipday_order_id: data.orderId ? String(data.orderId) : undefined,
        status: "sent",
      };
    }
    return {
      ok: false,
      status: `error: ${data?.response ?? `Shipday HTTP ${res.status}`}`,
    };
  } catch (err) {
    return { ok: false, status: `error: ${err instanceof Error ? err.message : "network error"}` };
  }
}

// ---- Dispatch orchestration (provider switch) --------------------------------

/** The site's board test-mode flag — the codebase's test-mode signal. */
export function boardTestModeOn(): boolean {
  return process.env.NEXT_PUBLIC_BOARD_TEST_MODE === "true";
}

/**
 * Pure dispatch decision: Shipday is only ever called for a REALLY
 * paid order while test mode is off. Everything else (test_paid,
 * unpaid, board test mode) is a test skip.
 */
export function shipdayDispatchDecision(
  paymentStatus: string,
  boardTestMode: boolean
): "send" | "test_skip" {
  return paymentStatus === "paid" && !boardTestMode ? "send" : "test_skip";
}

interface ShipdayOutcome {
  shipday_order_id?: string | null;
  shipday_status?: string;
  delivery_provider?: string;
  delivery_status?: string;
  delivery_error?: string | null;
}

/**
 * Records a dispatch outcome on the order. The shipday_* columns are
 * in the base schema (always present); the delivery_* columns arrive
 * with the Stage 3 schema, so they are written separately and a
 * missing column only logs (same fail-soft rule as lib/delivery.ts).
 */
async function recordShipdayOutcome(orderId: number, outcome: ShipdayOutcome): Promise<void> {
  try {
    const supabase = getServiceClient();
    const core: Record<string, unknown> = {};
    if (outcome.shipday_order_id) core.shipday_order_id = outcome.shipday_order_id;
    if (outcome.shipday_status !== undefined) core.shipday_status = outcome.shipday_status;
    if (Object.keys(core).length > 0) {
      const { error } = await supabase.from("orders").update(core).eq("id", orderId);
      if (error) console.error("[shipday] outcome record failed:", error.message);
    }
    const deliveryPatch: Record<string, unknown> = {};
    if (outcome.delivery_provider !== undefined) {
      deliveryPatch.delivery_provider = outcome.delivery_provider;
    }
    if (outcome.delivery_status !== undefined) {
      deliveryPatch.delivery_status = outcome.delivery_status;
      deliveryPatch.delivery_status_at = new Date().toISOString();
    }
    if (outcome.delivery_error !== undefined) {
      deliveryPatch.delivery_error = outcome.delivery_error;
    }
    if (Object.keys(deliveryPatch).length > 0) {
      const { error } = await supabase.from("orders").update(deliveryPatch).eq("id", orderId);
      if (error) {
        console.warn(
          "[shipday] orders.delivery_* columns missing — run supabase/stage3-schema.sql"
        );
      }
    }
  } catch (err) {
    console.error("[shipday] outcome record failed:", err);
  }
}

export interface ShipdayDispatchOrder extends ShipdayOrder {
  payment_status: string;
}

/**
 * Dispatch after payment when Shipday is the active provider (called
 * from markOrderPaid). Idempotent: an order that already has a
 * shipday_order_id is never sent twice. Records delivery_provider
 * 'shipday' in every outcome so the admin panel can tell the order
 * apart from DoorDash ones. A failure leaves the order PAID with
 * delivery_status 'pending' + the error text in shipday_status /
 * delivery_error — it never fails the customer's payment.
 */
export async function dispatchShipdayForOrder(
  order: ShipdayDispatchOrder
): Promise<{ ok: boolean; status: string }> {
  if (order.shipday_order_id) {
    return { ok: true, status: "already sent" };
  }
  if (shipdayDispatchDecision(order.payment_status, boardTestModeOn()) === "test_skip") {
    await recordShipdayOutcome(order.id, {
      shipday_status: "test mode — not sent",
      delivery_provider: "shipday",
    });
    return { ok: true, status: "test mode — not sent" };
  }
  const result = await dispatchToShipday(order);
  await recordShipdayOutcome(order.id, {
    shipday_order_id: result.shipday_order_id ?? undefined,
    shipday_status: result.status,
    delivery_provider: "shipday",
    delivery_status: result.ok ? "created" : "pending",
    delivery_error: result.ok ? null : result.status.slice(0, 500),
  });
  if (!result.ok) {
    console.error(`[shipday] dispatch for order #${order.id} failed:`, result.status);
  }
  return { ok: result.ok, status: result.status };
}

// ---- Webhook status mapping (pure) --------------------------------------------
// Shipday's documented "Order Status Update" webhook
// (docs.shipday.com/reference/order-status-update-2) POSTs:
//   { event, order_status, order: { id, order_number, ... }, ... }
//   event:        ORDER_ASSIGNED · ORDER_ACCEPTED_AND_STARTED ·
//                 ORDER_ONTHEWAY · ORDER_COMPLETED · ORDER_FAILED ·
//                 ORDER_INCOMPLETE · ORDER_DELETE · ORDER_INSERTED ·
//                 ORDER_PIKEDUP (Shipday's spelling) · ORDER_UNASSIGNED ·
//                 ORDER_PIKEDUP_REMOVED · ORDER_ONTHEWAY_REMOVED ·
//                 ORDER_POD_UPLOAD
//   order_status: NOT_ASSIGNED · NOT_ACCEPTED · NOT_STARTED_YET ·
//                 STARTED · PICKED_UP · READY_TO_DELIVER ·
//                 ALREADY_DELIVERED · INCOMPLETE · FAILED_DELIVERY
// The canonical values below are the delivery_status vocabulary of
// lib/deliveryStatus.ts (shared with DoorDash), so /track and the
// admin panel render Shipday progress with no extra code. Anything
// unrecognized maps to null — an unknown event NEVER changes an order
// (in particular, never marks one delivered).

const SHIPDAY_STATUS_TO_CANONICAL: Record<string, string> = {
  NOT_ASSIGNED: "created",
  NOT_ACCEPTED: "confirmed",
  NOT_STARTED_YET: "confirmed",
  STARTED: "enroute_to_pickup",
  PICKED_UP: "picked_up",
  READY_TO_DELIVER: "enroute_to_dropoff",
  ALREADY_DELIVERED: "delivered",
  FAILED_DELIVERY: "failed",
  INCOMPLETE: "failed",
  // Tolerated bare spellings (older / partner payload shapes).
  ASSIGNED: "confirmed",
  ACCEPTED: "confirmed",
  DELIVERED: "delivered",
  CANCELLED: "cancelled",
  CANCELED: "cancelled",
};

const SHIPDAY_EVENT_TO_CANONICAL: Record<string, string> = {
  ORDER_INSERTED: "created",
  ORDER_ASSIGNED: "confirmed",
  ORDER_UNASSIGNED: "created",
  ORDER_ACCEPTED_AND_STARTED: "enroute_to_pickup",
  ORDER_PIKEDUP: "picked_up",
  ORDER_ONTHEWAY: "enroute_to_dropoff",
  ORDER_COMPLETED: "delivered",
  ORDER_FAILED: "failed",
  ORDER_INCOMPLETE: "failed",
  ORDER_DELETE: "cancelled",
};

function normalizeShipdayToken(raw: string): string {
  return raw.toUpperCase().replace(/[\s-]+/g, "_").trim();
}

/**
 * Maps a Shipday status/event pair to a canonical delivery_status.
 * order_status (the state AFTER the event) wins when recognized;
 * the event name is the fallback. Returns null when neither is
 * recognized — the caller must then change nothing.
 */
export function shipdayStatusToCanonical(
  rawStatus: string,
  rawEvent: string
): string | null {
  const status = normalizeShipdayToken(rawStatus ?? "");
  if (status && SHIPDAY_STATUS_TO_CANONICAL[status]) {
    return SHIPDAY_STATUS_TO_CANONICAL[status];
  }
  const event = normalizeShipdayToken(rawEvent ?? "");
  if (event && SHIPDAY_EVENT_TO_CANONICAL[event]) {
    return SHIPDAY_EVENT_TO_CANONICAL[event];
  }
  return null;
}

export interface ShipdayWebhookParsed {
  /** Shipday's own order id (orders.shipday_order_id), "" when absent. */
  shipdayId: string;
  /** Our order number (Shipday's order_number = our order id), "" when absent. */
  orderNumber: string;
  /** Raw status text for the admin's shipday_status line. */
  rawStatus: string;
  /** Canonical delivery_status, or null when unrecognized. */
  canonical: string | null;
}

function pickLoose(obj: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return "";
}

/**
 * Tolerant parser for Shipday webhook payloads: the documented
 * nested shape first, then the flat shapes older integrations send.
 * Returns null only when the payload is not an object at all.
 */
export function parseShipdayWebhookPayload(payload: unknown): ShipdayWebhookParsed | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const root = payload as Record<string, unknown>;
  const order =
    root.order && typeof root.order === "object" && !Array.isArray(root.order)
      ? (root.order as Record<string, unknown>)
      : {};
  const shipdayId =
    pickLoose(order, ["id", "orderId", "order_id"]) ||
    pickLoose(root, ["orderId", "order_id", "shipdayOrderId"]);
  const orderNumber =
    pickLoose(order, ["order_number", "orderNumber", "orderNo"]) ||
    pickLoose(root, ["orderNumber", "order_number", "orderNo"]);
  const rawStatus =
    pickLoose(root, ["order_status", "orderStatus", "status", "deliveryStatus", "state"]) ||
    pickLoose(order, ["order_status", "orderStatus", "status"]);
  const rawEvent = pickLoose(root, ["event", "event_name", "event_type", "type"]);
  return {
    shipdayId,
    orderNumber,
    rawStatus: rawStatus || rawEvent,
    canonical: shipdayStatusToCanonical(rawStatus, rawEvent),
  };
}
