// POST /api/kitchen/status  { order_id, status }
// KITCHEN ONLY. Requires a valid Supabase Auth access token.
//
// One-tap flow (2026-11-18): the board only ever posts two statuses —
// "completed" (the chef's single tap on the card header = food ready)
// and "cancelled". Paid orders arrive already "accepted" (auto-accept
// in markOrderPaid). The legacy step values stay ACCEPTED here so an
// old client or a database row mid-migration can never wedge the
// board, and the pickup-ready SMS rule (lib/kitchenStatus) fires the
// text exactly once, on the first transition into ready/completed.

import { NextResponse } from "next/server";
import { getServiceClient, supabaseConfigured, verifyKitchenUser } from "@/lib/supabase/server";
import { reversePointsForCancelledOrder } from "@/lib/points";
import { smsPickupReady } from "@/lib/sms";
import { shouldSendReadySms } from "@/lib/kitchenStatus";
import { logAudit } from "@/lib/audit";

export const dynamic = "force-dynamic";

const ALLOWED = ["new", "accepted", "preparing", "ready", "completed", "cancelled"];

export async function POST(req: Request) {
  if (!supabaseConfigured()) {
    return NextResponse.json({ error: "Database is not configured." }, { status: 503 });
  }
  const user = await verifyKitchenUser(req);
  if (!user) {
    return NextResponse.json({ error: "Kitchen login required." }, { status: 401 });
  }
  let orderId = 0;
  let status = "";
  try {
    const body = (await req.json()) as { order_id?: number; status?: string };
    orderId = Math.floor(Number(body.order_id));
    status = String(body.status ?? "");
  } catch {
    /* handled below */
  }
  if (!orderId || !ALLOWED.includes(status)) {
    return NextResponse.json({ error: "Bad order_id or status." }, { status: 400 });
  }
  const supabase = getServiceClient();
  // Read the current state first: the ready-SMS rule needs the PREVIOUS
  // status to guarantee the text goes out exactly once.
  const { data: prev } = await supabase
    .from("orders")
    .select("id, customer_phone, fulfillment, kitchen_status")
    .eq("id", orderId)
    .maybeSingle();
  const { error } = await supabase
    .from("orders")
    .update({ kitchen_status: status })
    .eq("id", orderId);
  if (error) {
    console.error("[kitchen/status] update failed:", error);
    return NextResponse.json({ error: "Could not update the order." }, { status: 500 });
  }
  // SMS: the one-tap completion of a pickup order texts the customer
  // "your order is READY" — exactly once per order (best-effort; no-op
  // until Twilio is configured).
  if (
    prev &&
    shouldSendReadySms(prev.kitchen_status, status, prev.fulfillment)
  ) {
    try {
      await smsPickupReady(prev);
    } catch (err) {
      console.error("[kitchen/status] ready SMS failed:", err);
    }
  }
  // Loyalty: a cancelled order refunds its redeemed points and reverses
  // its earned points (best-effort, idempotent).
  if (status === "cancelled") {
    try {
      await reversePointsForCancelledOrder(orderId);
    } catch (err) {
      console.error("[kitchen/status] points reversal failed:", err);
    }
  }
  // Same audit trail as the admin panel's status changes (best-effort).
  await logAudit(user.email ?? user.id, "order.set_status", {
    order_id: orderId,
    status,
    via: "kitchen",
  });
  return NextResponse.json({ ok: true });
}
