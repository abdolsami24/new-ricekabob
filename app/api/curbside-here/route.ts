// POST /api/curbside-here  { order_id, phone }
// The curbside "I'm here" button (confirmation screen + /track page).
// The tap is recorded ONLY when the phone's last 10 digits match the
// phone used at checkout — the same rule as /api/track-order, with the
// same "never leak which part failed" answer for a wrong phone.
//
// The write is idempotent by design (lib/fulfillment decideCustomerHere
// + a guarded update): the FIRST tap on a paid, still-active curbside
// order sets orders.customer_here_at; every later tap returns the
// original time unchanged. The kitchen board lights the order up with
// "CUSTOMER IS HERE" until it is completed.
//
// Fail-soft: until supabase/curbside-schema.sql has run, the columns do
// not exist — the endpoint answers { ok: false, code: "not_available" }
// with a customer-clear message instead of an error.

import { NextResponse } from "next/server";
import { getServiceClient, supabaseConfigured } from "@/lib/supabase/server";
import { decideCustomerHere } from "@/lib/fulfillment";

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
  const { data: order, error } = await supabase
    .from("orders")
    .select(
      "id, customer_phone, fulfillment, payment_status, kitchen_status, customer_here_at"
    )
    .eq("id", orderId)
    .maybeSingle();
  if (error) {
    // Almost certainly the curbside columns are missing (the schema
    // file has not run yet) — fail soft with a clear answer.
    console.error("[curbside-here] order read failed:", error.message);
    return NextResponse.json({
      ok: false,
      code: "not_available",
      message:
        "Curbside check-in is still being set up — please come to the counter and give your order number.",
    });
  }
  if (!order || last10(String(order.customer_phone ?? "")) !== last10(phone)) {
    // Same answer for "no such order" and "wrong phone" — never leak which.
    return NextResponse.json({ found: false });
  }

  const decision = decideCustomerHere(order, new Date().toISOString());
  if (decision.action === "reject") {
    return NextResponse.json({ found: true, ok: false, reason: decision.reason });
  }
  if (decision.action === "already") {
    return NextResponse.json({
      found: true,
      ok: true,
      already_here: true,
      customer_here_at: decision.at,
    });
  }
  // First tap: guarded update — the IS NULL condition makes the write
  // itself atomic, so two simultaneous taps can never move the time.
  const { data: updated, error: updateError } = await supabase
    .from("orders")
    .update({ customer_here_at: decision.at })
    .eq("id", orderId)
    .is("customer_here_at", null)
    .select("customer_here_at")
    .maybeSingle();
  if (updateError) {
    console.error("[curbside-here] update failed:", updateError.message);
    return NextResponse.json({
      ok: false,
      code: "not_available",
      message:
        "Curbside check-in is still being set up — please come to the counter and give your order number.",
    });
  }
  if (!updated) {
    // Lost a race with a simultaneous tap — the stored (first) time wins.
    const { data: fresh } = await supabase
      .from("orders")
      .select("customer_here_at")
      .eq("id", orderId)
      .maybeSingle();
    return NextResponse.json({
      found: true,
      ok: true,
      already_here: true,
      customer_here_at: fresh?.customer_here_at ?? decision.at,
    });
  }
  return NextResponse.json({
    found: true,
    ok: true,
    already_here: false,
    customer_here_at: updated.customer_here_at,
  });
}
