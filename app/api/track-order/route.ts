// POST /api/track-order  { order_id, phone }
// Customer tracking. The order is returned ONLY when the phone's last 10
// digits match the phone used at checkout. The response is a sanitized
// view: no Stripe ids, no other customers' data, ever.

import { NextResponse } from "next/server";
import { getServiceClient, supabaseConfigured } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

function last10(phone: string): string {
  const digits = (phone || "").replace(/\D/g, "");
  return digits.slice(-10);
}

export async function POST(req: Request) {
  if (!supabaseConfigured()) {
    return NextResponse.json({ error: "not_configured" }, { status: 503 });
  }
  let orderId = 0;
  let phone = "";
  try {
    const body = (await req.json()) as { order_id?: number; phone?: string };
    orderId = Math.floor(Number(body.order_id));
    phone = String(body.phone ?? "");
  } catch {
    /* handled below */
  }
  if (!orderId || last10(phone).length < 10) {
    return NextResponse.json({ found: false }, { status: 400 });
  }
  const supabase = getServiceClient();
  // Optional columns are selected when they exist; until the matching
  // schema files run (stage3-schema.sql, then
  // service-fee-promo-schema.sql, then curbside-schema.sql), fall back
  // tier by tier to shorter column lists so tracking never breaks on a
  // not-yet-migrated DB.
  const baseCols =
    "id, customer_phone, items_json, subtotal_cents, tax_cents, delivery_fee_cents, tip_cents, total_cents, fulfillment, delivery_address, payment_status, kitchen_status, shipday_status, created_at";
  const stage3Cols = `${baseCols}, delivery_provider, delivery_status, delivery_markup_cents`;
  const feeCols = `${stage3Cols}, service_fee_cents, free_delivery`;
  const curbsideCols = `${feeCols}, car_description, customer_here_at`;
  // Live tracking (2026-11-23): DoorDash live-map URL + the house
  // driver's latest GPS fix — until live-tracking-schema.sql runs,
  // this select errors and the chain below falls back a tier.
  const liveCols = `${curbsideCols}, delivery_tracking_url, driver_lat, driver_lng, driver_loc_at`;
  let { data: order } = await supabase
    .from("orders")
    .select(liveCols)
    .eq("id", orderId)
    .maybeSingle();
  if (!order) {
    ({ data: order } = await supabase
      .from("orders")
      .select(curbsideCols)
      .eq("id", orderId)
      .maybeSingle());
  }
  if (!order) {
    ({ data: order } = await supabase
      .from("orders")
      .select(feeCols)
      .eq("id", orderId)
      .maybeSingle());
  }
  if (!order) {
    ({ data: order } = await supabase
      .from("orders")
      .select(stage3Cols)
      .eq("id", orderId)
      .maybeSingle());
  }
  if (!order) {
    ({ data: order } = await supabase
      .from("orders")
      .select(baseCols)
      .eq("id", orderId)
      .maybeSingle());
  }
  const full = (order ?? null) as (typeof order & {
    delivery_provider?: string | null;
    delivery_status?: string | null;
    delivery_markup_cents?: number;
    service_fee_cents?: number;
    free_delivery?: boolean;
    car_description?: string | null;
    customer_here_at?: string | null;
    delivery_tracking_url?: string | null;
    driver_lat?: number | null;
    driver_lng?: number | null;
    driver_loc_at?: string | null;
  }) | null;

  if (!full || last10(String(full.customer_phone ?? "")) !== last10(phone)) {
    // Same answer for "no such order" and "wrong phone" — never leak which.
    return NextResponse.json({ found: false });
  }

  return NextResponse.json({
    found: true,
    order: {
      id: full.id,
      items: full.items_json,
      subtotal_cents: full.subtotal_cents,
      service_fee_cents: full.service_fee_cents ?? 0,
      tax_cents: full.tax_cents,
      delivery_fee_cents: full.delivery_fee_cents,
      delivery_markup_cents: full.delivery_markup_cents ?? 0,
      free_delivery: full.free_delivery ?? false,
      tip_cents: full.tip_cents,
      total_cents: full.total_cents,
      fulfillment: full.fulfillment,
      delivery_address: full.fulfillment === "delivery" ? full.delivery_address : null,
      // Curbside: the car text + whether the customer has tapped
      // "I'm here" yet (drives the button on the tracking page).
      car_description: full.fulfillment === "curbside" ? (full.car_description ?? null) : null,
      customer_here_at: full.customer_here_at ?? null,
      payment_status: full.payment_status,
      kitchen_status: full.kitchen_status,
      shipday_status: full.shipday_status,
      // Stage 3: DoorDash delivery state for the tracking timeline.
      delivery_provider: full.delivery_provider ?? null,
      delivery_status: full.delivery_status ?? null,
      // Live tracking: DoorDash's live-map URL + the house driver's
      // latest GPS fix (delivery orders only).
      delivery_tracking_url:
        full.fulfillment === "delivery" ? (full.delivery_tracking_url ?? null) : null,
      driver_lat:
        full.fulfillment === "delivery" ? (full.driver_lat ?? null) : null,
      driver_lng:
        full.fulfillment === "delivery" ? (full.driver_lng ?? null) : null,
      driver_loc_at:
        full.fulfillment === "delivery" ? (full.driver_loc_at ?? null) : null,
      created_at: full.created_at,
    },
  });
}
