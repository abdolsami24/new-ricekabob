// POST /api/delivery-quote
// Body: { address, phone?, name?, tip_cents?, subtotal_cents? }
// The DoorDash Drive quote step (Stage 3): geocodes the address,
// enforces the site's delivery radius (site_settings
// delivery_max_miles, default 8), asks DoorDash (live) or the
// published rate card (mock) for the fee, and STORES the quote.
// Checkout later re-loads this stored quote by id — the fee the
// browser saw is never trusted.
//
// Response (ok): { quote_id, fee_cents, fee, service_fee_cents,
//   service_fee, delivery_total_cents, delivery_charge_cents,
//   delivery_charge, free_delivery, expires_at, provider_mode,
//   estimated_dropoff_at, miles }
//   fee_cents / service_fee_cents keep their Stage 3 meaning (pure
//   DoorDash fee / the restaurant's extra markup). delivery_total_cents
//   is their sum; delivery_charge_cents is what the customer actually
//   pays for delivery — the same merged sum, or 0 with free_delivery
//   true when the Free Delivery promotion applies at the subtotal the
//   browser sent. Checkout re-verifies all of it server-side.
// Response (error): { error: "not_found" | "far" | "unavailable",
//   message } — the UI shows the message and offers retry.

import { NextResponse } from "next/server";
import { createDeliveryQuote } from "@/lib/delivery";
import { getFeeSettings } from "@/lib/fees";
import { customerDeliveryCents, freeDeliveryApplies } from "@/lib/feePricing";
import { formatCents } from "@/lib/menu";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  let body: Record<string, unknown> = {};
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    /* handled below */
  }
  const address = String(body.address ?? "").trim().slice(0, 300);
  if (address.length < 6) {
    return NextResponse.json(
      { error: "not_found", message: "Please enter the full delivery address." },
      { status: 400 }
    );
  }
  const tip_cents = Math.min(
    Math.max(Math.floor(Number(body.tip_cents) || 0), 0),
    20000
  );
  const subtotal_cents = Math.max(Math.floor(Number(body.subtotal_cents) || 0), 0);
  const outcome = await createDeliveryQuote({
    address,
    phone: body.phone ? String(body.phone).trim().slice(0, 30) : undefined,
    name: body.name ? String(body.name).trim().slice(0, 80) : undefined,
    tip_cents,
    subtotal_cents,
  });
  if (!outcome.ok) {
    return NextResponse.json({ error: outcome.error, message: outcome.message });
  }
  const { quote, markup_cents } = outcome;
  // Free Delivery promotion preview at the cart subtotal the browser
  // sent (display only — checkout recomputes from the stored quote
  // and the server-built subtotal before charging anything).
  const feeSettings = await getFeeSettings();
  const free_delivery = freeDeliveryApplies(subtotal_cents, feeSettings.free_delivery);
  const delivery_charge_cents = customerDeliveryCents(
    quote.fee_cents,
    markup_cents,
    free_delivery
  );
  return NextResponse.json({
    quote_id: quote.id,
    // House Delivery update: WHICH provider the resolution picked
    // ('house' | 'shipday' | 'doordash') and the stored quote's raw
    // mode — the storefront only needs the fee either way, but the
    // label helps the customer ("our driver" vs a courier).
    provider:
      outcome.provider_mode === "house"
        ? "house"
        : outcome.provider_mode === "shipday"
          ? "shipday"
          : "doordash",
    provider_mode: outcome.provider_mode,
    fee_cents: quote.fee_cents,
    fee: formatCents(quote.fee_cents),
    service_fee_cents: markup_cents,
    service_fee: formatCents(markup_cents),
    delivery_total_cents: quote.fee_cents + markup_cents,
    delivery_charge_cents,
    delivery_charge: formatCents(delivery_charge_cents),
    free_delivery,
    expires_at: quote.expires_at,
    estimated_dropoff_at: outcome.estimated_dropoff_at,
    miles: quote.miles,
  });
}
