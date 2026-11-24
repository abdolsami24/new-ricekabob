// DoorDash Drive client — the ONLY delivery provider for this site
// (it replaced Shipday in Stage 3; lib/shipday.ts is kept for history
// but nothing calls it for new orders anymore).
//
// Two modes, chosen purely by environment:
//  - LIVE: DOORDASH_DEVELOPER_ID + DOORDASH_KEY_ID +
//    DOORDASH_SIGNING_SECRET are all set. Real calls to
//    https://openapi.doordash.com with a short-lived JWT
//    (HS256, header "dd-ver": "DD-JWT-V1", claims aud="doordash",
//    iss=developer id, kid=key id, exp = iat + 300 — per the official
//    DoorDash Drive JWT reference). The signing secret is
//    base64-decoded before use as the HMAC key, exactly as DoorDash's
//    own tutorial does.
//  - MOCK: credentials absent. Quotes are priced from DoorDash's
//    PUBLISHED rate card (lib/deliveryPricing.ts) and deliveries are
//    simulated locally. Mock data is always flagged provider_mode
//    'mock' in the database and in the admin panel — it is never
//    presented to anyone as real DoorDash data.
//
// Customers order and pay ONLY on this website; DoorDash is just the
// driver network behind the scenes.

import { createHmac } from "crypto";
import { mockDeliveryFeeCents } from "./deliveryPricing";
import { normalizePhone } from "./shipday";

const API_BASE = "https://openapi.doordash.com";

export const RESTAURANT_NAME = "Madinah Market";
export const RESTAURANT_ADDRESS = "3126 S Parker Rd, Aurora, CO 80014, USA";
export const RESTAURANT_PHONE = "+17207630786";

export type DoorDashMode = "live" | "mock";

export function doordashMode(): DoorDashMode {
  return process.env.DOORDASH_DEVELOPER_ID &&
    process.env.DOORDASH_KEY_ID &&
    process.env.DOORDASH_SIGNING_SECRET
    ? "live"
    : "mock";
}

export function doordashConfigured(): boolean {
  return doordashMode() === "live";
}

// ---- JWT --------------------------------------------------------------------

function base64url(input: Buffer | string): string {
  const buf = typeof input === "string" ? Buffer.from(input, "utf8") : input;
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function makeJwt(): string {
  const developerId = process.env.DOORDASH_DEVELOPER_ID!;
  const keyId = process.env.DOORDASH_KEY_ID!;
  const secret = process.env.DOORDASH_SIGNING_SECRET!;
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "HS256", typ: "JWT", "dd-ver": "DD-JWT-V1" };
  const claims = { aud: "doordash", iss: developerId, kid: keyId, iat: now, exp: now + 300 };
  const unsigned = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`;
  // DoorDash's tutorial decodes the signing secret from base64 before
  // using it as the HMAC key. Node's base64 decoder also accepts the
  // base64url alphabet, so either portal format works.
  const key = Buffer.from(secret, "base64");
  const signature = createHmac("sha256", key).update(unsigned).digest();
  return `${unsigned}.${base64url(signature)}`;
}

async function ddFetch(
  path: string,
  init: { method: string; body?: Record<string, unknown> }
): Promise<Record<string, unknown>> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: init.method,
    headers: {
      Authorization: `Bearer ${makeJwt()}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    ...(init.body ? { body: JSON.stringify(init.body) } : {}),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const message =
      (typeof data.message === "string" && data.message) ||
      (typeof data.code === "string" && data.code) ||
      `DoorDash HTTP ${res.status}`;
    throw new Error(`DoorDash: ${message}`);
  }
  return data;
}

// ---- Shared shapes ------------------------------------------------------------

export interface QuoteRequest {
  /** Caller-generated id — OUR idempotency key for this delivery. */
  external_delivery_id: string;
  dropoff_address: string;
  dropoff_phone: string;
  dropoff_name?: string;
  dropoff_instructions?: string;
  order_value_cents: number;
  tip_cents: number;
  miles: number;
}

export interface QuoteResult {
  external_delivery_id: string;
  fee_cents: number;
  provider_mode: DoorDashMode;
  estimated_dropoff_at: string | null;
  /** Expiry DoorDash reported, when it reports one (ISO string). */
  expires_at: string | null;
}

export interface DeliveryResult {
  external_delivery_id: string;
  delivery_status: string;
  support_reference: string | null;
  tracking_url: string | null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function feeFrom(data: Record<string, unknown>): number {
  const fee = Number(data.fee);
  if (!Number.isFinite(fee) || fee < 0) throw new Error("DoorDash: quote had no fee");
  return Math.round(fee);
}

// ---- Quotes -------------------------------------------------------------------

export async function createDoorDashQuote(req: QuoteRequest): Promise<QuoteResult> {
  if (doordashMode() === "mock") {
    const fee = mockDeliveryFeeCents(req.miles, req.tip_cents);
    if (fee === null) {
      throw new Error("That address is outside the delivery area.");
    }
    return {
      external_delivery_id: req.external_delivery_id,
      fee_cents: fee,
      provider_mode: "mock",
      estimated_dropoff_at: new Date(Date.now() + 45 * 60000).toISOString(),
      expires_at: null,
    };
  }
  const data = await ddFetch("/drive/v2/quotes", {
    method: "POST",
    body: {
      external_delivery_id: req.external_delivery_id,
      pickup_address: RESTAURANT_ADDRESS,
      pickup_business_name: RESTAURANT_NAME,
      pickup_phone_number: RESTAURANT_PHONE,
      pickup_instructions: "Please come inside to the counter and give the order number.",
      dropoff_address: req.dropoff_address,
      dropoff_phone_number: normalizePhone(req.dropoff_phone),
      ...(req.dropoff_name
        ? { dropoff_contact_given_name: req.dropoff_name.split(" ")[0].slice(0, 40) }
        : {}),
      ...(req.dropoff_instructions
        ? { dropoff_instructions: req.dropoff_instructions.slice(0, 300) }
        : {}),
      order_value: req.order_value_cents,
      tip: req.tip_cents,
      currency: "USD",
    },
  });
  return {
    external_delivery_id: str(data.external_delivery_id) ?? req.external_delivery_id,
    fee_cents: feeFrom(data),
    provider_mode: "live",
    estimated_dropoff_at: str(data.dropoff_time_estimated),
    expires_at: str(data.expires_at) ?? str(data.quote_expires_at),
  };
}

// ---- Dispatch (after payment) ---------------------------------------------------

export interface DispatchRequest extends QuoteRequest {
  items: { name: string; qty: number }[];
}

/**
 * Turns a paid order's quote into a real delivery. Live mode accepts
 * the quote first (the recommended restaurant flow); if the accept
 * fails — most often because DoorDash's real quote window (5 minutes)
 * closed while the customer was paying — it falls back to creating
 * the delivery directly with the SAME external_delivery_id, which
 * DoorDash treats idempotently. Mock mode simulates a created
 * delivery.
 */
export async function dispatchDoorDashDelivery(req: DispatchRequest): Promise<DeliveryResult> {
  if (doordashMode() === "mock") {
    return {
      external_delivery_id: req.external_delivery_id,
      delivery_status: "created",
      support_reference: `MOCK-${req.external_delivery_id}`,
      tracking_url: null,
    };
  }
  // 1) Accept the quote.
  try {
    const data = await ddFetch(
      `/drive/v2/quotes/${encodeURIComponent(req.external_delivery_id)}/accept`,
      {
        method: "POST",
        body: {
          tip: req.tip_cents,
          dropoff_phone_number: normalizePhone(req.dropoff_phone),
        },
      }
    );
    return {
      external_delivery_id: str(data.external_delivery_id) ?? req.external_delivery_id,
      delivery_status: str(data.delivery_status) ?? "created",
      support_reference: str(data.support_reference),
      tracking_url: str(data.tracking_url),
    };
  } catch (acceptErr) {
    console.warn("[doordash] quote accept failed, creating delivery directly:", acceptErr);
  }
  // 2) Fallback: create the delivery directly, same external id.
  const data = await ddFetch("/drive/v2/deliveries", {
    method: "POST",
    body: {
      external_delivery_id: req.external_delivery_id,
      pickup_address: RESTAURANT_ADDRESS,
      pickup_business_name: RESTAURANT_NAME,
      pickup_phone_number: RESTAURANT_PHONE,
      pickup_instructions: "Please come inside to the counter and give the order number.",
      dropoff_address: req.dropoff_address,
      dropoff_phone_number: normalizePhone(req.dropoff_phone),
      ...(req.dropoff_name
        ? { dropoff_contact_given_name: req.dropoff_name.split(" ")[0].slice(0, 40) }
        : {}),
      ...(req.dropoff_instructions
        ? { dropoff_instructions: req.dropoff_instructions.slice(0, 300) }
        : {}),
      order_value: req.order_value_cents,
      tip: req.tip_cents,
      currency: "USD",
      items: req.items.map((i) => ({ name: i.name.slice(0, 100), quantity: i.qty })),
    },
  });
  return {
    external_delivery_id: str(data.external_delivery_id) ?? req.external_delivery_id,
    delivery_status: str(data.delivery_status) ?? "created",
    support_reference: str(data.support_reference),
    tracking_url: str(data.tracking_url),
  };
}

// ---- Status ---------------------------------------------------------------------

export async function getDoorDashDelivery(
  externalDeliveryId: string
): Promise<{ delivery_status: string; tracking_url: string | null } | null> {
  if (doordashMode() === "mock") return null; // mock status lives in our DB
  const data = await ddFetch(`/drive/v2/deliveries/${encodeURIComponent(externalDeliveryId)}`, {
    method: "GET",
  });
  const status = str(data.delivery_status);
  if (!status) return null;
  return { delivery_status: status, tracking_url: str(data.tracking_url) };
}

/** DoorDash delivery lifecycle, in order (for the mock "advance" step). */
export const MOCK_STATUS_FLOW = [
  "created",
  "confirmed",
  "enroute_to_pickup",
  "arrived_at_pickup",
  "picked_up",
  "enroute_to_dropoff",
  "arrived_at_dropoff",
  "delivered",
];

/** Next status in the mock lifecycle (null when already terminal). */
export function mockNextStatus(current: string | null): string | null {
  const idx = MOCK_STATUS_FLOW.indexOf((current ?? "created").toLowerCase());
  if (idx === -1) return "confirmed";
  if (idx >= MOCK_STATUS_FLOW.length - 1) return null;
  return MOCK_STATUS_FLOW[idx + 1];
}

// Customer-facing status labels / timeline mapping live in
// lib/deliveryStatus.ts (pure, client-safe) — this module imports
// node:crypto for JWT signing and must stay server-only.
