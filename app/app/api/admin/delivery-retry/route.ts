// POST /api/admin/delivery-retry  { order_id, action }
// STAFF ONLY (same staff-token check as the other admin routes).
//   action "retry":   re-run the DoorDash dispatch for a paid delivery
//                     order whose delivery is missing or stuck in
//                     'pending'. Reuses the order's stored quote /
//                     external_delivery_id, so it can never create a
//                     duplicate delivery or a second charge.
//   action "refresh": pull the current delivery status (live: GET
//                     from DoorDash; mock: advance the simulated
//                     lifecycle one step) and store it on the order.
// Both actions are audit-logged by the caller pattern used across the
// admin panel.

import { NextResponse } from "next/server";
import { getServiceClient, supabaseConfigured, verifyKitchenUser } from "@/lib/supabase/server";
import { dispatchDeliveryForOrder, refreshDeliveryStatus, registerHouseDelivery, type DeliveryOrderLike } from "@/lib/delivery";
import { logAudit } from "@/lib/audit";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  if (!supabaseConfigured()) {
    return NextResponse.json({ error: "Database is not configured." }, { status: 503 });
  }
  const user = await verifyKitchenUser(req).catch(() => null);
  if (!user) {
    return NextResponse.json({ error: "Staff login required." }, { status: 401 });
  }
  let body: Record<string, unknown> = {};
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }
  const orderId = Math.floor(Number(body.order_id));
  const action = body.action === "refresh" ? "refresh" : "retry";
  if (!orderId) {
    return NextResponse.json({ error: "order_id is required" }, { status: 400 });
  }
  const supabase = getServiceClient();
  const { data: order, error } = await supabase
    .from("orders")
    .select("*")
    .eq("id", orderId)
    .maybeSingle();
  if (error || !order) {
    return NextResponse.json({ error: "Order not found." }, { status: 404 });
  }
  const row = order as DeliveryOrderLike & { payment_status: string };
  if (row.fulfillment !== "delivery") {
    return NextResponse.json({ error: "That order is not a delivery order." }, { status: 400 });
  }
  const actor = user.email ?? user.id;

  // House Delivery orders have NO external dispatch — never let the
  // DoorDash retry/refresh below touch them. "Retry" simply
  // re-registers the house order (status + driver token); "refresh"
  // reports the status the driver page last set.
  if ((row as { delivery_provider?: string | null }).delivery_provider === "house") {
    if (action === "refresh") {
      return NextResponse.json({ ok: true, delivery_status: row.delivery_status ?? "pending" });
    }
    await registerHouseDelivery(row as { id: number; driver_token?: string | null });
    await logAudit(actor, "delivery.house_register", { order_id: orderId });
    return NextResponse.json({ ok: true });
  }

  if (action === "refresh") {
    const result = await refreshDeliveryStatus(row);
    await logAudit(actor, "delivery.refresh_status", {
      order_id: orderId,
      status: result.status,
      ok: result.ok,
    });
    if (!result.ok) {
      return NextResponse.json({ error: result.error ?? "Refresh failed" }, { status: 400 });
    }
    return NextResponse.json({ ok: true, delivery_status: result.status });
  }

  // retry
  if (row.payment_status !== "paid" && row.payment_status !== "test_paid") {
    return NextResponse.json(
      { error: "Only a paid order can be dispatched to DoorDash." },
      { status: 400 }
    );
  }
  if (row.delivery_external_id && row.delivery_status && row.delivery_status !== "pending") {
    return NextResponse.json(
      { error: "This order already has a delivery — use Refresh status instead." },
      { status: 400 }
    );
  }
  // A stuck 'pending' order keeps its external id unset, so the retry
  // re-runs dispatch with the same stored quote/external id.
  const result = await dispatchDeliveryForOrder({ ...row, delivery_external_id: null });
  await logAudit(actor, "delivery.retry", { order_id: orderId, ok: result.ok });
  if (!result.ok) {
    return NextResponse.json(
      { error: result.error ?? "Dispatch failed — see the delivery error on the order." },
      { status: 502 }
    );
  }
  return NextResponse.json({ ok: true, already: result.already ?? false });
}
