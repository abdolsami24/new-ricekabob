// POST /api/shipday-webhook
//
// Shipday calls this whenever a delivery's status changes ("Order
// Status Update" webhook — payload documented at
// docs.shipday.com/reference/order-status-update-2):
//   { event, order_status, order: { id, order_number, ... }, ... }
// The handler is tolerant: it also reads the flat payload shapes
// older integrations send, and unknown events are ignored with a
// 200 — an unrecognized payload NEVER changes an order (and in
// particular never marks one delivered).
//
// Recognized statuses are mapped onto orders.delivery_status (the
// canonical vocabulary in lib/deliveryStatus.ts) so the customer's
// /track page and the admin panel show progress, and the "delivered"
// SMS fires exactly once — the same shared path DoorDash uses.
//
// Token check: when SHIPDAY_WEBHOOK_TOKEN is set in the environment,
// the call must carry it — Shipday sends the validation token in a
// header named "token" when one is configured in their dashboard;
// the legacy "x-shipday-token" header and a ?token= query are also
// accepted. A mismatch is a closed 401 rejection. When the token is
// NOT set, payloads are still processed (the lookup keys are
// Shipday's own order id / our order number) — setting the token is
// recommended; see the update README.
//
// The route ALWAYS answers 200 once a payload was understood or
// safely ignored, so Shipday does not retry storms; it never throws.

import { timingSafeEqual } from "crypto";
import { NextResponse } from "next/server";
import { supabaseConfigured } from "@/lib/supabase/server";
import { parseShipdayWebhookPayload } from "@/lib/shipday";
import { applyShipdayStatus } from "@/lib/delivery";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

function tokenOk(req: Request): boolean {
  const expected = (process.env.SHIPDAY_WEBHOOK_TOKEN ?? "").trim();
  if (!expected) return true; // no token configured — see header note
  const url = new URL(req.url);
  const provided =
    req.headers.get("token") ??
    req.headers.get("x-shipday-token") ??
    url.searchParams.get("token") ??
    "";
  return safeEqual(provided.trim(), expected);
}

export async function POST(req: Request) {
  if (!tokenOk(req)) {
    return NextResponse.json({ error: "unverified" }, { status: 401 });
  }
  let payload: unknown = null;
  try {
    payload = await req.json();
  } catch {
    // Not JSON — nothing to apply; answer 200 so Shipday stops.
    return NextResponse.json({ ok: true, ignored: "not_json" });
  }
  const parsed = parseShipdayWebhookPayload(payload);
  if (!parsed) {
    return NextResponse.json({ ok: true, ignored: "bad_payload" });
  }
  if (!parsed.canonical) {
    // Unknown event/status — change nothing, by design.
    return NextResponse.json({ ok: true, ignored: "unknown_status" });
  }
  if (!parsed.shipdayId && !parsed.orderNumber) {
    return NextResponse.json({ ok: true, ignored: "no_order_ref" });
  }
  if (!supabaseConfigured()) {
    return NextResponse.json({ ok: true, ignored: "no_database" });
  }
  try {
    const applied = await applyShipdayStatus({
      shipdayId: parsed.shipdayId,
      orderNumber: parsed.orderNumber,
      rawStatus: parsed.rawStatus,
      canonical: parsed.canonical,
    });
    return NextResponse.json({ ok: true, applied });
  } catch (err) {
    console.error("[shipday-webhook] apply failed:", err);
    return NextResponse.json({ ok: true, applied: false });
  }
}
