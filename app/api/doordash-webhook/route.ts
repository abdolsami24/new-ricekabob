// POST /api/doordash-webhook
// DoorDash Drive delivery status callbacks (Stage 3).
//
// Verification (LIVE mode): a status change is applied ONLY when the
// request proves it knows DOORDASH_WEBHOOK_SECRET — via the
// "x-doordash-webhook-secret" header, a ?token= parameter, the
// password of the Basic-Auth header (the Developer Portal's webhook
// basic-auth setting), or an X-DoorDash-Signature HMAC-SHA256 of the
// raw body keyed with the DoorDash signing secret. If the secret is
// not configured in live mode the webhook is REJECTED — unverified
// status changes are never accepted. As a second layer, after a
// verified webhook the delivery is re-fetched from the DoorDash API
// and the API's status wins.
// Verification (MOCK mode): the same shared-secret check applies only
// when DOORDASH_WEBHOOK_SECRET is set; mock deliveries are simulated
// locally anyway.
//
// The handler only records delivery status — it never touches money,
// items, or kitchen state. DoorDash retries non-200 answers, so
// verified-but-unmatched events still answer 200.

import { NextResponse } from "next/server";
import { createHmac, timingSafeEqual } from "crypto";
import { supabaseConfigured } from "@/lib/supabase/server";
import {
  applyDeliveryStatusByExternalId,
  saveTrackingUrlByExternalId,
} from "@/lib/delivery";
import { doordashMode, getDoorDashDelivery } from "@/lib/doordash";

export const dynamic = "force-dynamic";

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

function verified(req: Request, rawBody: string): boolean {
  const secret = process.env.DOORDASH_WEBHOOK_SECRET;
  if (doordashMode() === "mock") {
    if (!secret) return true; // mock: secret optional
  } else if (!secret) {
    console.warn(
      "[doordash-webhook] LIVE mode but DOORDASH_WEBHOOK_SECRET is not set — rejecting unverified webhook."
    );
    return false;
  }
  if (!secret) return true;
  const url = new URL(req.url);
  const headerSecret = req.headers.get("x-doordash-webhook-secret") ?? "";
  if (headerSecret && safeEqual(headerSecret, secret)) return true;
  const token = url.searchParams.get("token") ?? "";
  if (token && safeEqual(token, secret)) return true;
  // Developer Portal webhook Basic Auth: password must equal the secret.
  const auth = req.headers.get("authorization") ?? "";
  if (auth.toLowerCase().startsWith("basic ")) {
    try {
      const decoded = Buffer.from(auth.slice(6).trim(), "base64").toString("utf8");
      const password = decoded.slice(decoded.indexOf(":") + 1);
      if (password && safeEqual(password, secret)) return true;
    } catch {
      /* fall through */
    }
  }
  // HMAC signature variant: X-DoorDash-Signature over the raw body,
  // keyed with the signing secret (raw or base64-decoded).
  const signature = req.headers.get("x-doordash-signature") ?? "";
  const signingSecret = process.env.DOORDASH_SIGNING_SECRET;
  if (signature && signingSecret) {
    const keys = [Buffer.from(signingSecret, "utf8"), Buffer.from(signingSecret, "base64")];
    for (const key of keys) {
      const expected = createHmac("sha256", key).update(rawBody).digest("hex");
      if (safeEqual(signature.toLowerCase(), expected)) return true;
    }
  }
  return false;
}

const EVENT_TO_STATUS: Record<string, string> = {
  DELIVERY_CREATED: "created",
  DASHER_CONFIRMED: "confirmed",
  DASHER_EN_ROUTE_TO_PICKUP: "enroute_to_pickup",
  DASHER_ENROUTE_TO_PICKUP: "enroute_to_pickup",
  DASHER_CONFIRMED_PICKUP_ARRIVAL: "arrived_at_pickup",
  DASHER_ARRIVED_AT_PICKUP: "arrived_at_pickup",
  DASHER_PICKED_UP: "picked_up",
  DASHER_EN_ROUTE_TO_DROPOFF: "enroute_to_dropoff",
  DASHER_ENROUTE_TO_DROPOFF: "enroute_to_dropoff",
  DASHER_CONFIRMED_DROPOFF_ARRIVAL: "arrived_at_dropoff",
  DASHER_ARRIVED_AT_DROPOFF: "arrived_at_dropoff",
  DASHER_DROPPED_OFF: "delivered",
  DELIVERY_DELIVERED: "delivered",
  DELIVERY_CANCELLED: "cancelled",
  DELIVERY_CANCELED: "cancelled",
};

export async function POST(req: Request) {
  const rawBody = await req.text();
  if (!verified(req, rawBody)) {
    return NextResponse.json({ error: "unverified" }, { status: 401 });
  }
  let payload: Record<string, unknown> = {};
  try {
    payload = JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ ok: true });
  }
  if (!supabaseConfigured()) return NextResponse.json({ ok: true });

  const externalId =
    typeof payload.external_delivery_id === "string" ? payload.external_delivery_id : "";
  if (!externalId) return NextResponse.json({ ok: true });

  let status =
    typeof payload.delivery_status === "string" ? payload.delivery_status : "";
  if (!status) {
    const eventName = String(payload.event_name ?? payload.event_type ?? "")
      .toUpperCase()
      .replace(/[\s-]+/g, "_");
    status = EVENT_TO_STATUS[eventName] ?? "";
  }
  if (status) {
    await applyDeliveryStatusByExternalId(externalId, status);
  }
  // DoorDash payloads carry the live-map URL — keep ours fresh so
  // the customer track page and Admin can show it.
  if (typeof payload.tracking_url === "string" && payload.tracking_url) {
    await saveTrackingUrlByExternalId(externalId, payload.tracking_url);
  }
  // Defense in depth (live): the API's own status is authoritative.
  if (doordashMode() === "live") {
    try {
      const current = await getDoorDashDelivery(externalId);
      if (current && current.delivery_status !== status) {
        await applyDeliveryStatusByExternalId(externalId, current.delivery_status);
      }
      if (current?.tracking_url) {
        await saveTrackingUrlByExternalId(externalId, current.tracking_url);
      }
    } catch (err) {
      console.warn("[doordash-webhook] status re-fetch failed:", err);
    }
  }
  return NextResponse.json({ ok: true });
}
