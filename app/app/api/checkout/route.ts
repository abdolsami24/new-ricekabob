// POST /api/checkout
// Body: { items: [{id, qty}], customer_name, customer_phone, fulfillment,
//         delivery_address?, car_description? (curbside), delivery_quote_id?,
//         tip_percent?, tip_custom_cents?, note? }
// The server rebuilds the order from lib/menu (browser prices are never
// trusted), saves it as "unpaid", then either returns a Stripe Checkout URL
// (real mode) or { test_mode: true, order_id } (test mode).
// Delivery fee (Stage 3): NEVER from the browser and no longer from
// distance bands — it is re-loaded from the stored DoorDash quote
// (delivery_quote_id, created by /api/delivery-quote), verified
// unexpired and for this exact address. The restaurant's extra
// delivery markup is added on top, here on the server; the customer
// is charged ONE merged "Delivery fee" (the split is stored on the
// order and shown in the admin panel only).
// Service Fee + Free Delivery: the general Service Fee (all orders,
// never taxed, never waived) and the Free Delivery promotion
// (delivery orders whose food subtotal reaches the admin's amount
// pay $0 delivery) are likewise computed HERE from admin settings
// and the server-built subtotal — never from client-sent values.

import { NextResponse } from "next/server";
import { buildLines, computeTotals, computeTipCents } from "@/lib/pricing";
import { verifyQuoteForCheckout, getDeliverySettings, markupFor } from "@/lib/delivery";
import { getFeeSettings } from "@/lib/fees";
import {
  computeServiceFeeCents,
  customerDeliveryCents,
  freeDeliveryApplies,
} from "@/lib/feePricing";
import { formatCents } from "@/lib/menu";
import { getServiceClient, supabaseConfigured, verifyCustomerUser } from "@/lib/supabase/server";
import { getStripe, siteUrl, stripeTestMode } from "@/lib/stripe";
import { getPointsBalance, redemptionFor, redeemPointsForOrder } from "@/lib/points";
import { getSettings, getUnavailableIds, getHoursConfig } from "@/lib/admin";
import { normalizeFulfillment } from "@/lib/fulfillment";
import { getPricingMenuById } from "@/lib/menuDb";
import { validatePickupTime } from "@/lib/hours";
import type Stripe from "stripe";

export const dynamic = "force-dynamic";

function bad(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

export async function POST(req: Request) {
  if (!supabaseConfigured()) {
    return bad("Ordering is not configured yet (database). Please call the restaurant.", 503);
  }
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return bad("Invalid request body");
  }

  const customer_name = String(body.customer_name ?? "").trim().slice(0, 80);
  const customer_phone = String(body.customer_phone ?? "").trim().slice(0, 30);
  // 'pickup' | 'curbside' | 'delivery' (lib/fulfillment). Curbside is
  // pickup for money: it NEVER enters the delivery-quote path below.
  const fulfillment = normalizeFulfillment(body.fulfillment);
  const delivery_address = String(body.delivery_address ?? "").trim().slice(0, 300);
  const car_description = String(body.car_description ?? "").trim().slice(0, 80);
  const note = String(body.note ?? "").trim().slice(0, 200);

  if (customer_name.length < 2) return bad("Please enter your name");
  if (customer_phone.replace(/\D/g, "").length < 7) return bad("Please enter your phone number");
  if (fulfillment === "curbside" && car_description.length < 3) {
    return bad("Please tell us your car (color & type) so we can find you outside.");
  }

  // Admin switches: the whole system, or one fulfillment type, may be off.
  const settings = await getSettings();
  if (!settings.ordering_enabled) {
    return bad("Online ordering is currently closed. Please call us at 720-763-0786.", 403);
  }
  if (fulfillment === "pickup" && !settings.pickup_enabled) {
    return bad("Pickup ordering is currently off. Please choose delivery or call us.", 400);
  }
  if (fulfillment === "curbside" && !settings.curbside_enabled) {
    return bad("Curbside pickup is currently off. Please choose pickup or delivery, or call us.", 400);
  }
  if (fulfillment === "delivery" && !settings.delivery_enabled) {
    return bad("Delivery ordering is currently off. Please choose pickup or call us.", 400);
  }

  // Scheduled pickup ("pickup for later"): today only, inside pickup hours.
  let scheduled_for: string | null = null;
  if (fulfillment === "pickup" && typeof body.scheduled_for === "string" && body.scheduled_for) {
    const problem = validatePickupTime(body.scheduled_for, new Date(), await getHoursConfig());
    if (problem) return bad(problem);
    scheduled_for = new Date(body.scheduled_for).toISOString();
  }

  let lines;
  try {
    lines = buildLines(
      body.items as { id: string; qty: number }[],
      await getPricingMenuById()
    );  } catch (err) {
    return bad(err instanceof Error ? err.message : "Invalid cart");
  }

  // Sold-out dishes (admin-marked) cannot be ordered.
  const unavailable = await getUnavailableIds();
  const soldOut = lines.find((l) => unavailable.has(l.id));
  if (soldOut) {
    return bad(`${soldOut.name} just sold out — please remove it from your cart.`);
  }

  const subtotal = lines.reduce((s, l) => s + l.line_total_cents, 0);

  // Service Fee (all orders) + Free Delivery settings — fail-soft OFF.
  const feeSettings = await getFeeSettings();
  const service_fee_cents = computeServiceFeeCents(subtotal, feeSettings.service_fee);

  // Delivery fee: NEVER from the browser. The provider for THIS
  // order is resolved at quote time (House → DoorDash → Shipday
  // among the enabled switches, with radius fall-through) and the
  // verified stored quote fixes both the provider and the fee; the
  // provider is saved on the order so dispatch after payment uses
  // exactly what the customer was charged for.
  // Legacy fallback: when Shipday is the ONLY enabled provider the
  // storefront never quotes (flat fee) — that path is unchanged.
  let delivery_fee_cents = 0;
  let delivery_markup_cents = 0;
  let delivery_quote_row_id: string | null = null;
  let delivery_provider: "house" | "shipday" | "doordash" | null = null;
  let free_delivery = false;
  if (fulfillment === "delivery") {
    if (delivery_address.length < 6) return bad("Please enter the delivery address");
    const deliverySettings = await getDeliverySettings();
    const quoteId = String(body.delivery_quote_id ?? "").trim();
    if (!quoteId) {
      if (
        deliverySettings.shipday_enabled &&
        !deliverySettings.house_enabled &&
        !deliverySettings.doordash_enabled
      ) {
        // Shipday-only (the pre-House provider-switch behavior): no
        // quote exists — the customer pays the flat Shipday fee; no
        // radius cap and no delivery minimum apply.
        delivery_provider = "shipday";
        delivery_fee_cents = deliverySettings.shipday_fee_cents;
        delivery_markup_cents = 0;
        free_delivery = freeDeliveryApplies(subtotal, feeSettings.free_delivery);
      } else {
        return bad("Please wait for the delivery fee quote, then place your order again.");
      }
    } else {
      const check = await verifyQuoteForCheckout(quoteId, delivery_address);
      if (!check.ok) {
        if (check.reason === "expired") {
          // The storefront re-quotes and shows the new total; the
          // customer must confirm it before paying — never charge a
          // silently changed fee.
          return NextResponse.json(
            {
              error:
                "Your delivery quote expired, so we refreshed the fee. Please review the total and place the order again.",
              code: "quote_expired",
            },
            { status: 409 }
          );
        }
        if (check.reason === "address_mismatch") {
          return bad("The delivery address changed — please wait for a new delivery quote.");
        }
        return bad("That delivery quote is no longer valid. Please re-enter the address to get a new quote.");
      }
      delivery_quote_row_id = check.quote.id;
      delivery_fee_cents = check.quote.fee_cents;
      const mode = check.quote.provider_mode;
      if (mode === "house" || mode === "shipday") {
        // Locally priced providers: the stored quote fee IS the
        // customer fee (tier price / flat fee); no markup. The
        // delivery minimum applies to House exactly as it did to
        // DoorDash; Shipday never had one. Free Delivery zeroes
        // either fee the same way.
        delivery_provider = mode;
        delivery_markup_cents = 0;
        if (
          mode === "house" &&
          deliverySettings.min_subtotal_cents > 0 &&
          subtotal < deliverySettings.min_subtotal_cents
        ) {
          return bad(
            `Delivery orders need a food subtotal of at least ${formatCents(
              deliverySettings.min_subtotal_cents
            )}. Please add a little more, or choose pickup.`
          );
        }
        free_delivery = freeDeliveryApplies(subtotal, feeSettings.free_delivery);
      } else {
        // 'live' / 'mock' — DoorDash Drive: fee from the stored
        // quote only, the restaurant's markup computed from the
        // current admin settings at this moment, delivery minimum
        // enforced, Free Delivery decided from the stored quote +
        // the server-computed subtotal. The quote/fee/markup are
        // stored on the order; the customer pays $0 delivery when
        // the promotion applies and the restaurant absorbs it.
        delivery_provider = "doordash";
        if (
          deliverySettings.min_subtotal_cents > 0 &&
          subtotal < deliverySettings.min_subtotal_cents
        ) {
          return bad(
            `Delivery orders need a food subtotal of at least ${formatCents(
              deliverySettings.min_subtotal_cents
            )}. Please add a little more, or choose pickup.`
          );
        }
        delivery_markup_cents = markupFor(delivery_fee_cents, deliverySettings);
        free_delivery = freeDeliveryApplies(subtotal, feeSettings.free_delivery);
      }
    }
  }
  const tip_cents = computeTipCents(
    subtotal,
    typeof body.tip_percent === "number" ? body.tip_percent : undefined,
    typeof body.tip_custom_cents === "number" ? body.tip_custom_cents : undefined
  );

  // Optional: if the customer is signed in, link the order to their
  // account so it appears in their order history. Guests simply omit the
  // Authorization header and stay anonymous, as before.
  const customerUser = await verifyCustomerUser(req).catch(() => null);

  // Loyalty redemption (signed-in customers only): the server checks the
  // real balance and applies whole 100-point blocks ($5.00 each) off the
  // subtotal. The client's numbers are never trusted.
  let discount_cents = 0;
  let points_redeemed = 0;
  if (body.use_points === true && customerUser) {
    try {
      const balance = await getPointsBalance(customerUser.id);
      const redemption = redemptionFor(balance, subtotal);
      discount_cents = redemption.discount_cents;
      points_redeemed = redemption.points;
    } catch (err) {
      console.error("[checkout] points balance check failed:", err);
    }
  }
  // The customer pays ONE merged delivery charge (pure courier fee +
  // markup), or $0 when the Free Delivery promotion applies; the order
  // row stores the parts separately (delivery_fee_cents stays the PURE
  // fee — the DoorDash quote fee, or the flat Shipday fee in Shipday
  // mode) so the admin panel can show the split / absorbed fee.
  const customer_delivery_cents = customerDeliveryCents(
    delivery_fee_cents,
    delivery_markup_cents,
    free_delivery
  );
  const totals = computeTotals(
    lines,
    customer_delivery_cents,
    tip_cents,
    discount_cents,
    service_fee_cents
  );

  const supabase = getServiceClient();
  const baseRow = {
    user_id: customerUser?.id ?? null,
    customer_name,
    customer_phone,
    items_json: lines,
    subtotal_cents: totals.subtotal_cents,
    discount_cents: totals.discount_cents,
    points_redeemed,
    tax_cents: totals.tax_cents,
    delivery_fee_cents,
    tip_cents: totals.tip_cents,
    total_cents: totals.total_cents,
    fulfillment,
    delivery_address: fulfillment === "delivery" ? delivery_address : null,
    scheduled_for,
    payment_status: "unpaid",
    kitchen_status: "new",
  };
  let { data: order, error } = await supabase
    .from("orders")
    .insert({
      ...baseRow,
      delivery_quote_id: delivery_quote_row_id,
      delivery_markup_cents,
      // The provider fixed by the verified quote (House update) —
      // dispatch after payment follows THIS, not the live switches.
      delivery_provider,
      service_fee_cents: totals.service_fee_cents,
      free_delivery,
      // Curbside car text (null for pickup/delivery). Dropped by the
      // fallback below until supabase/curbside-schema.sql has run.
      car_description: fulfillment === "curbside" ? car_description : null,
      // Order-level checkout note (null when blank). Dropped by the
      // fallback below until supabase/order-note-schema.sql has run —
      // an order must never fail to save because of the note.
      note: note || null,
    })
    .select("id")
    .single();
  if (error && /note/i.test(error.message)) {
    // supabase/order-note-schema.sql not run yet — save the order
    // without the note (everything else about the order is unchanged).
    console.warn("[checkout] Note column missing — inserting without it.");
    ({ data: order, error } = await supabase
      .from("orders")
      .insert({
        ...baseRow,
        delivery_quote_id: delivery_quote_row_id,
        delivery_markup_cents,
        delivery_provider,
        service_fee_cents: totals.service_fee_cents,
        free_delivery,
        car_description: fulfillment === "curbside" ? car_description : null,
      })
      .select("id")
      .single());
  }
  if (error && /(delivery_|service_fee|free_delivery|car_description)/i.test(error.message)) {
    // supabase/service-fee-promo-schema.sql not run yet — save the
    // order without the two newest columns (totals are unchanged;
    // only the service-fee / free-delivery record is not stored).
    console.warn("[checkout] Service-fee columns missing — inserting without them.");
    ({ data: order, error } = await supabase
      .from("orders")
      .insert({
        ...baseRow,
        delivery_quote_id: delivery_quote_row_id,
        delivery_markup_cents,
        delivery_provider,
      })
      .select("id")
      .single());
  }
  if (error && /delivery_/i.test(error.message)) {
    // supabase/stage3-schema.sql not run yet — save the order without
    // the Stage 3 columns (the delivery still works end to end; only
    // the quote link / markup split is not recorded).
    console.warn("[checkout] Stage 3 columns missing — inserting without them.");
    ({ data: order, error } = await supabase
      .from("orders")
      .insert(baseRow)
      .select("id")
      .single());
  }
  if (error || !order) {
    console.error("[checkout] insert failed:", error);
    return bad("Could not create the order. Please try again.", 500);
  }
  const orderId = order.id as number;

  // Record the redemption in the ledger (idempotent per order).
  if (points_redeemed > 0 && customerUser) {
    try {
      await redeemPointsForOrder(customerUser.id, orderId, points_redeemed);
    } catch (err) {
      console.error("[checkout] points redeem failed:", err);
    }
  }

  // TEST MODE: no Stripe key — the client will call /api/test-pay next.
  if (stripeTestMode()) {
    return NextResponse.json({ test_mode: true, order_id: orderId });
  }

  // Real mode: Stripe Checkout with separate line items so the Stripe total
  // equals the order total exactly.
  try {
    const stripe = getStripe();
    const lineItems: Stripe.Checkout.SessionCreateParams.LineItem[] = lines.map((l) => ({
      quantity: l.qty,
      price_data: {
        currency: "usd",
        // Per-unit price INCLUDING the chosen options (line_total is an
        // exact multiple of qty by construction in buildLines).
        unit_amount: Math.round(l.line_total_cents / l.qty),
        product_data: {
          name: l.options?.length
            ? `${l.name} (${l.options.map((o) => o.name).join(", ")})`.slice(0, 120)
            : l.name,
        },
      },
    }));
    if (totals.service_fee_cents > 0) {
      lineItems.push({
        quantity: 1,
        price_data: {
          currency: "usd",
          unit_amount: totals.service_fee_cents,
          product_data: { name: "Service fee" },
        },
      });
    }
    if (totals.tax_cents > 0) {
      lineItems.push({
        quantity: 1,
        price_data: {
          currency: "usd",
          unit_amount: totals.tax_cents,
          product_data: { name: "Sales tax (8%)" },
        },
      });
    }
    // ONE merged delivery line (DoorDash fee + extra markup). When
    // the Free Delivery promotion applied, the charge is $0 and no
    // line is added — the Stripe total still equals the order total.
    if (customer_delivery_cents > 0) {
      lineItems.push({
        quantity: 1,
        price_data: {
          currency: "usd",
          unit_amount: customer_delivery_cents,
          product_data: { name: "Delivery fee" },
        },
      });
    }
    if (totals.tip_cents > 0) {
      lineItems.push({
        quantity: 1,
        price_data: {
          currency: "usd",
          unit_amount: totals.tip_cents,
          product_data: { name: "Tip — thank you!" },
        },
      });
    }
    // Loyalty discount: Stripe line items can't be negative, so use a
    // one-time amount-off coupon — the charged total stays exact.
    let discounts: Stripe.Checkout.SessionCreateParams.Discount[] | undefined;
    if (totals.discount_cents > 0) {
      const coupon = await stripe.coupons.create({
        amount_off: totals.discount_cents,
        currency: "usd",
        duration: "once",
        name: "Loyalty points",
      });
      discounts = [{ coupon: coupon.id }];
    }
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: lineItems,
      ...(discounts ? { discounts } : {}),
      metadata: { order_id: String(orderId) },
      success_url: `${siteUrl()}/menu?order=${orderId}&paid=1`,
      cancel_url: `${siteUrl()}/menu?order=${orderId}&cancelled=1`,
    });
    await supabase
      .from("orders")
      .update({ stripe_session_id: session.id })
      .eq("id", orderId);
    return NextResponse.json({ url: session.url, order_id: orderId });
  } catch (err) {
    console.error("[checkout] Stripe session failed:", err);
    return bad("Payment could not be started. Please try again.", 502);
  }
}
