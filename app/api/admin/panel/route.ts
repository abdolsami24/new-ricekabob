// /api/admin/panel — data + actions for the Operations admin panel.
// STAFF ONLY (same Supabase staff-token check as /api/admin and the
// kitchen routes). The storefront never calls this route; /api/admin's
// public GET shape is unchanged.
//
// GET ?section=overview|orders|reports|staff|audit|catalog|security
//     orders accepts &status=&payment=&q=&from=&to=
// POST actions (JSON):
//     { action: "update_item", id, name, number, category, price_cents,
//       description, station, option_groups? }
//       option_groups (optional) is the options editor's dollars-based
//       shape: [{ name, single?, choices: [{ name, price, hide_price? }] }].
//       When present it is strictly validated (see validateEditorOptionGroups)
//       and stored with the dish; when absent the dish's options are untouched.
//     { action: "delete_item", id }
//     { action: "rename_category", from, to }
//     { action: "set_order_status", order_id, status }
// Every successful mutation is written to the audit log (best-effort).

import { NextResponse } from "next/server";
import { supabaseConfigured, verifyKitchenUser } from "@/lib/supabase/server";
import { getServiceClient } from "@/lib/supabase/server";
import {
  getOverview,
  listPanelOrders,
  getReports,
  listStaff,
  getCatalog,
  updateMenuItem,
  deleteMenuItem,
  renameCategory,
  KITCHEN_STATUSES,
} from "@/lib/panel";
import { listAudit, logAudit } from "@/lib/audit";
import { validateEditorOptionGroups } from "@/lib/menuOptions";
import { reversePointsForCancelledOrder } from "@/lib/points";
import { smsPickupReady } from "@/lib/sms";
import { shouldSendReadySms } from "@/lib/kitchenStatus";
import { doordashMode } from "@/lib/doordash";
import { twilioConfigured } from "@/lib/sms";
import { freshkdsConfigured } from "@/lib/freshkds";

export const dynamic = "force-dynamic";

async function requireStaff(req: Request) {
  if (!supabaseConfigured()) {
    return {
      error: NextResponse.json(
        { error: "Database is not configured." },
        { status: 503 }
      ),
    };
  }
  const user = await verifyKitchenUser(req).catch(() => null);
  if (!user) {
    return {
      error: NextResponse.json({ error: "Staff login required." }, { status: 401 }),
    };
  }
  return { user };
}

export async function GET(req: Request) {
  const gate = await requireStaff(req);
  if (gate.error) return gate.error;
  const url = new URL(req.url);
  const section = url.searchParams.get("section") ?? "overview";
  try {
    switch (section) {
      case "overview":
        return NextResponse.json({ section, ...(await getOverview()) });
      case "orders": {
        const orders = await listPanelOrders({
          status: url.searchParams.get("status") ?? undefined,
          payment: url.searchParams.get("payment") ?? undefined,
          q: url.searchParams.get("q") ?? undefined,
          from: url.searchParams.get("from") ?? undefined,
          to: url.searchParams.get("to") ?? undefined,
        });
        return NextResponse.json({ section, orders });
      }
      case "reports":
        return NextResponse.json({ section, ...(await getReports()) });
      case "staff":
        return NextResponse.json({ section, ...(await listStaff()) });
      case "audit": {
        const audit = await listAudit(100);
        return NextResponse.json({ section, ...audit });
      }
      case "catalog":
        return NextResponse.json({ section, ...(await getCatalog()) });
      case "security":
        return NextResponse.json({
          section,
          // Booleans only — key values never leave the server.
          supabase_configured: supabaseConfigured(),
          stripe_configured: Boolean(process.env.STRIPE_SECRET_KEY),
          test_mode: !process.env.STRIPE_SECRET_KEY,
          board_test_mode: process.env.NEXT_PUBLIC_BOARD_TEST_MODE === "true",
          shipday_configured: Boolean(process.env.SHIPDAY_API_KEY),
          // Stage 3: DoorDash Drive + Twilio status.
          doordash_configured: doordashMode() === "live",
          doordash_mode: doordashMode(),
          doordash_webhook_secret_configured: Boolean(process.env.DOORDASH_WEBHOOK_SECRET),
          twilio_configured: twilioConfigured(),
          // Fresh KDS kitchen screens (token presence only — the
          // token value itself never leaves the server).
          freshkds_configured: freshkdsConfigured(),
        });
      default:
        return NextResponse.json({ error: "Unknown section" }, { status: 400 });
    }
  } catch (err) {
    console.error("[admin/panel] section failed:", err);
    return NextResponse.json({ error: "Could not load this section." }, { status: 500 });
  }
}

export async function POST(req: Request) {
  const gate = await requireStaff(req);
  if (gate.error) return gate.error;
  const actor = gate.user.email ?? gate.user.id;
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }
  try {
    switch (body.action) {
      case "update_item": {
        const id = String(body.id ?? "");
        const name = String(body.name ?? "").trim().slice(0, 80);
        const category = String(body.category ?? "").trim().slice(0, 60);
        const description = String(body.description ?? "").trim().slice(0, 300);
        const numberRaw = String(body.number ?? "").trim().slice(0, 10);
        const station = String(body.station ?? "main").trim().slice(0, 40) || "main";
        const price_cents = Math.floor(Number(body.price_cents));
        if (!id) throw new Error("Missing dish id");
        if (!name) throw new Error("A dish needs a name");
        if (!category) throw new Error("Choose a category");
        if (!Number.isFinite(price_cents) || price_cents < 1 || price_cents > 100000) {
          throw new Error("Enter a valid price");
        }
        // Options editor: only when the key is present in the request.
        // Validation throws a staff-readable error on any problem, so a
        // bad options edit rejects the whole save before anything writes.
        const option_groups = Object.prototype.hasOwnProperty.call(body, "option_groups")
          ? validateEditorOptionGroups(body.option_groups)
          : undefined;
        await updateMenuItem(id, {
          name,
          number: numberRaw || null,
          category,
          price_cents,
          description,
          station,
          option_groups,
        });
        await logAudit(actor, "catalog.update_item", { id, name, category, price_cents, station });
        if (option_groups !== undefined) {
          await logAudit(actor, "catalog.update_item_options", {
            id,
            groups: option_groups.length,
            choices: option_groups.reduce((n, g) => n + g.choices.length, 0),
          });
        }
        break;
      }
      case "delete_item": {
        const id = String(body.id ?? "");
        if (!id) throw new Error("Missing dish id");
        await deleteMenuItem(id);
        await logAudit(actor, "catalog.delete_item", { id });
        break;
      }
      case "rename_category": {
        const from = String(body.from ?? "").trim().slice(0, 60);
        const to = String(body.to ?? "").trim().slice(0, 60);
        if (!from || !to) throw new Error("Both category names are required");
        await renameCategory(from, to);
        await logAudit(actor, "catalog.rename_category", { from, to });
        break;
      }
      case "set_order_status": {
        const orderId = Math.floor(Number(body.order_id));
        const status = String(body.status ?? "");
        if (!orderId || !KITCHEN_STATUSES.includes(status)) {
          throw new Error("Bad order_id or status.");
        }
        const supabase = getServiceClient();
        // Previous state first: the shared ready-SMS rule needs it to
        // fire the pickup-ready text exactly once per order.
        const { data: prev } = await supabase
          .from("orders")
          .select("id, customer_phone, fulfillment, kitchen_status")
          .eq("id", orderId)
          .maybeSingle();
        const { data, error } = await supabase
          .from("orders")
          .update({ kitchen_status: status })
          .eq("id", orderId)
          .select("id, kitchen_status")
          .maybeSingle();
        if (error) throw error;
        if (!data) throw new Error("Order not found.");
        // Same SMS rule as the kitchen board (one-tap flow): the first
        // transition into ready/completed texts a pickup customer
        // (best-effort). The panel UI now only posts "cancelled" and
        // the kitchen tap posts "completed", but the rule covers the
        // legacy step values too.
        if (
          prev &&
          shouldSendReadySms(prev.kitchen_status, status, prev.fulfillment)
        ) {
          try {
            await smsPickupReady(prev);
          } catch (err) {
            console.error("[admin/panel] ready SMS failed:", err);
          }
        }
        // Same loyalty rule as the kitchen board: cancelling refunds the
        // redeemed points and reverses the earned ones (best-effort).
        if (status === "cancelled") {
          try {
            await reversePointsForCancelledOrder(orderId);
          } catch (err) {
            console.error("[admin/panel] points reversal failed:", err);
          }
        }
        await logAudit(actor, "order.set_status", { order_id: orderId, status });
        break;
      }
      default:
        return NextResponse.json({ error: "Unknown action" }, { status: 400 });
    }
  } catch (err) {
    console.error("[admin/panel] action failed:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Action failed" },
      { status: 400 }
    );
  }
  return NextResponse.json({ ok: true });
}
