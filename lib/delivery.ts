// Delivery orchestration (Stage 3) — settings, quote storage, dispatch
// after payment, and status sync for DoorDash Drive. Sits between the
// API routes and lib/doordash.ts (the raw API client).
//
// FAIL-SOFT RULE (same as the rest of this codebase): until Sami runs
// supabase/stage3-schema.sql, the delivery_quotes table and the
// orders.delivery_* columns do not exist. Every read/write here
// degrades to defaults / logged no-ops instead of throwing, so the
// live site keeps working exactly as before.

import { randomBytes, randomUUID } from "crypto";
import { getServiceClient } from "./supabase/server";
import { geocodeAddress, milesBetween, restaurantCoords } from "./geocode";
import {
  createDoorDashQuote,
  dispatchDoorDashDelivery,
  getDoorDashDelivery,
  mockNextStatus,
  doordashMode,
} from "./doordash";
import {
  computeDeliveryMarkupCents,
  DOORDASH_MAX_MILES,
  normalizeShipdayFeeCents,
  parseDeliveryProvider,
  parseHouseTiers,
  houseFeeForMiles,
  houseMaxMiles,
  DEFAULT_HOUSE_TIERS,
  type DeliveryProviderName,
  type AnyDeliveryProvider,
  type HouseTier,
} from "./deliveryPricing";
import { smsDeliveryDelivered, smsDeliveryOnItsWay } from "./sms";

// ---- Settings (site_settings, same pattern as the hours editor) -------------

export type DeliveryProvider = DeliveryProviderName;

export interface DeliverySettings {
  /** Site delivery radius cap in miles (food quality). Default 8. */
  max_miles: number;
  /** Minimum food subtotal for delivery orders, cents. 0 = off. */
  min_subtotal_cents: number;
  /** Extra flat fee on top of the DoorDash fee, cents. 0 = off. */
  markup_flat_cents: number;
  /** Extra fee as % of the DoorDash fee. 0 = off. */
  markup_percent: number;
  /**
   * Active delivery provider (provider switch): 'doordash' (default —
   * Stage 3 behavior) or 'shipday' (flat fee, no quote; dispatch via
   * lib/shipday.ts). Switching affects NEW paid orders only.
   * Since the House Delivery update this is a DERIVED legacy view
   * (the first enabled provider in priority order, mapped back to
   * the two legacy names) kept so older readers stay sane — the
   * three switches below are the real state.
   */
  provider: DeliveryProvider;
  /** Flat delivery fee charged to the customer in Shipday mode, cents. */
  shipday_fee_cents: number;
  /**
   * House Delivery update (2026-11-23): three independent ON/OFF
   * switches. Resolution order when several are ON: House →
   * DoorDash → Shipday, with fall-through when a provider cannot
   * serve the address (House radius tiers / DoorDash radius cap).
   */
  doordash_enabled: boolean;
  shipday_enabled: boolean;
  house_enabled: boolean;
  /** House Delivery radius tiers ("up to X miles → $Y"), sorted. */
  house_tiers: HouseTier[];
}

export const DEFAULT_DELIVERY_SETTINGS: DeliverySettings = {
  max_miles: 8,
  min_subtotal_cents: 0,
  markup_flat_cents: 0,
  markup_percent: 0,
  provider: "doordash",
  shipday_fee_cents: 699,
  doordash_enabled: true,
  shipday_enabled: false,
  house_enabled: false,
  house_tiers: DEFAULT_HOUSE_TIERS,
};

const DELIVERY_SETTING_KEYS = [
  "delivery_max_miles",
  "delivery_min_subtotal_cents",
  "delivery_markup_flat_cents",
  "delivery_markup_percent",
  "delivery_provider",
  "shipday_delivery_fee_cents",
  "delivery_doordash_enabled",
  "delivery_shipday_enabled",
  "delivery_house_enabled",
  "house_delivery_tiers",
] as const;

function numValue(value: unknown, fallback: number): number {
  const n = typeof value === "string" ? Number(value) : (value as number);
  return typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : fallback;
}

function boolValue(value: unknown): boolean | null {
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  return null;
}

/** The provider an order resolves to first under these settings. */
export function primaryProvider(settings: DeliverySettings): AnyDeliveryProvider {
  if (settings.house_enabled) return "house";
  if (settings.doordash_enabled) return "doordash";
  if (settings.shipday_enabled) return "shipday";
  return settings.provider;
}

export async function getDeliverySettings(): Promise<DeliverySettings> {
  const settings = { ...DEFAULT_DELIVERY_SETTINGS, house_tiers: [...DEFAULT_HOUSE_TIERS] };
  try {
    const supabase = getServiceClient();
    const { data, error } = await supabase
      .from("site_settings")
      .select("key, value")
      .in("key", [...DELIVERY_SETTING_KEYS]);
    if (error) return settings;
    const raw = new Map<string, unknown>();
    for (const row of data ?? []) {
      raw.set(row.key as string, (row as { value: unknown }).value);
    }
    if (raw.has("delivery_max_miles")) {
      settings.max_miles = Math.min(numValue(raw.get("delivery_max_miles"), 8) || 8, DOORDASH_MAX_MILES);
    }
    if (raw.has("delivery_min_subtotal_cents")) {
      settings.min_subtotal_cents = Math.round(numValue(raw.get("delivery_min_subtotal_cents"), 0));
    }
    if (raw.has("delivery_markup_flat_cents")) {
      settings.markup_flat_cents = Math.round(numValue(raw.get("delivery_markup_flat_cents"), 0));
    }
    if (raw.has("delivery_markup_percent")) {
      settings.markup_percent = Math.min(numValue(raw.get("delivery_markup_percent"), 0), 100);
    }
    if (raw.has("delivery_provider")) {
      settings.provider = parseDeliveryProvider(raw.get("delivery_provider"));
    }
    if (raw.has("shipday_delivery_fee_cents")) {
      settings.shipday_fee_cents = normalizeShipdayFeeCents(
        raw.get("shipday_delivery_fee_cents"),
        settings.shipday_fee_cents
      );
    }
    // The three switches. MIGRATION: until any switch key has ever
    // been saved, the switches mirror the legacy single provider
    // exactly (shipday mode → Shipday ON / DoorDash OFF; otherwise
    // DoorDash ON / Shipday OFF; House starts OFF) so the live site
    // behaves identically the moment this code deploys.
    const dd = boolValue(raw.get("delivery_doordash_enabled"));
    const sd = boolValue(raw.get("delivery_shipday_enabled"));
    const hs = boolValue(raw.get("delivery_house_enabled"));
    if (dd === null && sd === null && hs === null) {
      settings.doordash_enabled = settings.provider !== "shipday";
      settings.shipday_enabled = settings.provider === "shipday";
      settings.house_enabled = false;
    } else {
      settings.doordash_enabled = dd ?? settings.provider !== "shipday";
      settings.shipday_enabled = sd ?? settings.provider === "shipday";
      settings.house_enabled = hs ?? false;
    }
    if (raw.has("house_delivery_tiers")) {
      settings.house_tiers = parseHouseTiers(raw.get("house_delivery_tiers"));
    }
  } catch {
    /* defaults */
  }
  return settings;
}

export async function setDeliverySettings(input: DeliverySettings): Promise<void> {
  const supabase = getServiceClient();
  const now = new Date().toISOString();
  const tiers = parseHouseTiers(input.house_tiers);
  // The legacy single-provider key follows the switches (first
  // enabled in priority order; House maps to 'doordash' there since
  // the legacy type has no 'house') so any older reader still sees
  // a sane value.
  const primary = primaryProvider({ ...input, house_tiers: tiers });
  const rows = [
    { key: "delivery_max_miles", value: input.max_miles, updated_at: now },
    { key: "delivery_min_subtotal_cents", value: input.min_subtotal_cents, updated_at: now },
    { key: "delivery_markup_flat_cents", value: input.markup_flat_cents, updated_at: now },
    { key: "delivery_markup_percent", value: input.markup_percent, updated_at: now },
    { key: "delivery_provider", value: parseDeliveryProvider(primary), updated_at: now },
    {
      key: "shipday_delivery_fee_cents",
      value: normalizeShipdayFeeCents(input.shipday_fee_cents),
      updated_at: now,
    },
    { key: "delivery_doordash_enabled", value: input.doordash_enabled === true, updated_at: now },
    { key: "delivery_shipday_enabled", value: input.shipday_enabled === true, updated_at: now },
    { key: "delivery_house_enabled", value: input.house_enabled === true, updated_at: now },
    { key: "house_delivery_tiers", value: tiers, updated_at: now },
  ];
  const { error } = await supabase
    .from("site_settings")
    .upsert(rows, { onConflict: "key" });
  if (error) throw error;
}

/** Markup for a quote fee under the current settings. */
export function markupFor(feeCents: number, settings: DeliverySettings): number {
  return computeDeliveryMarkupCents(
    feeCents,
    settings.markup_flat_cents,
    settings.markup_percent
  );
}

// ---- Stored quotes --------------------------------------------------------------

export interface StoredQuote {
  id: string;
  quote_id: string;
  provider_mode: string;
  fee_cents: number;
  miles: number;
  dropoff_address: string;
  dropoff_phone: string | null;
  dropoff_name: string | null;
  expires_at: string;
  created_at: string;
}

export type QuoteOutcome =
  | {
      ok: true;
      quote: StoredQuote;
      markup_cents: number;
      estimated_dropoff_at: string | null;
      /** 'house' | 'shipday' | 'live' | 'mock' — who will deliver. */
      provider_mode: string;
    }
  | { ok: false; error: "not_found" | "far" | "unavailable"; message: string };

/**
 * Stores a locally-priced quote (House tiers / Shipday flat fee) in
 * the same delivery_quotes table the DoorDash quotes use, so
 * checkout verifies EVERY provider's fee the same way: re-loaded
 * from the stored row, never from the browser.
 */
async function storeLocalQuote(input: {
  providerMode: "house" | "shipday";
  feeCents: number;
  miles: number;
  address: string;
  phone?: string;
  name?: string;
}): Promise<QuoteOutcome> {
  const expiresAt = new Date(Date.now() + 10 * 60000).toISOString();
  try {
    const supabase = getServiceClient();
    const { data, error } = await supabase
      .from("delivery_quotes")
      .insert({
        quote_id: `${input.providerMode}-${randomUUID()}`,
        provider_mode: input.providerMode,
        fee_cents: input.feeCents,
        miles: Math.round(input.miles * 100) / 100,
        dropoff_address: input.address,
        dropoff_phone: input.phone ?? null,
        dropoff_name: input.name ?? null,
        expires_at: expiresAt,
      })
      .select("*")
      .single();
    if (error || !data) throw error ?? new Error("quote insert failed");
    return {
      ok: true,
      quote: data as StoredQuote,
      markup_cents: 0,
      estimated_dropoff_at: null,
      provider_mode: input.providerMode,
    };
  } catch (err) {
    console.error("[delivery] local quote could not be stored:", err);
    return {
      ok: false,
      error: "unavailable",
      message:
        "Delivery is being set up right now. Please try again shortly, or choose pickup.",
    };
  }
}

/**
 * Resolves the delivery provider for an address and prices it.
 * Priority (Sami's rule, 2026-11-23): House → DoorDash → Shipday
 * among the ENABLED providers, falling through when a provider
 * cannot serve the address (beyond the House tiers / beyond the
 * DoorDash radius cap). Shipday has no radius — it is the last
 * resort and always prices. When nothing is enabled (or every
 * radius is exceeded with Shipday off), the outcome is 'far'.
 */
export async function createDeliveryQuote(input: {
  address: string;
  phone?: string;
  name?: string;
  tip_cents?: number;
  subtotal_cents?: number;
}): Promise<QuoteOutcome> {
  const settings = await getDeliverySettings();
  const geo = await geocodeAddress(input.address);
  if (!geo) {
    return {
      ok: false,
      error: "not_found",
      message: "We could not find that address. Please check it and try again.",
    };
  }
  const r = restaurantCoords();
  const miles = milesBetween(r.lat, r.lng, geo.lat, geo.lng);
  const maxMiles = Math.min(settings.max_miles || 8, DOORDASH_MAX_MILES);

  // 1) House Delivery — the restaurant's own driver, radius tiers.
  if (settings.house_enabled) {
    const tier = houseFeeForMiles(settings.house_tiers, miles);
    if (tier) {
      return storeLocalQuote({
        providerMode: "house",
        feeCents: tier.fee_cents,
        miles,
        address: input.address,
        phone: input.phone,
        name: input.name,
      });
    }
    // Beyond the largest tier: fall through to the next provider.
  }

  // 2) DoorDash Drive — quoted fee, radius-capped.
  if (settings.doordash_enabled && miles <= maxMiles) {
    return createDoorDashStoredQuote(input, settings, miles);
  }

  // 3) Shipday — flat fee, no radius.
  if (settings.shipday_enabled) {
    return storeLocalQuote({
      providerMode: "shipday",
      feeCents: settings.shipday_fee_cents,
      miles,
      address: input.address,
      phone: input.phone,
      name: input.name,
    });
  }

  // Nothing enabled can serve this address.
  const limit = Math.max(
    settings.house_enabled ? houseMaxMiles(settings.house_tiers) : 0,
    settings.doordash_enabled ? maxMiles : 0
  );
  return {
    ok: false,
    error: "far",
    message:
      limit > 0
        ? `Sorry — that address is outside our delivery area (about ${miles.toFixed(
            1
          )} miles away; we deliver within ${limit} miles). Please choose pickup.`
        : "Delivery is not available right now. Please choose pickup, or call us at 720-763-0786.",
  };
}

/** The original Stage 3 DoorDash quote path (extracted unchanged). */
async function createDoorDashStoredQuote(
  input: {
    address: string;
    phone?: string;
    name?: string;
    tip_cents?: number;
    subtotal_cents?: number;
  },
  settings: DeliverySettings,
  miles: number
): Promise<QuoteOutcome> {
  // The external_delivery_id is generated HERE, at quote time (quotes
  // exist before orders do), and is bound to the order at checkout.
  // Accept / retry / status calls all reuse it — that is the
  // idempotency key DoorDash dedupes on.
  const externalId = `ddq-${randomUUID()}`;
  let created;
  try {
    created = await createDoorDashQuote({
      external_delivery_id: externalId,
      dropoff_address: input.address,
      dropoff_phone: input.phone ?? "",
      dropoff_name: input.name,
      order_value_cents: input.subtotal_cents ?? 0,
      tip_cents: input.tip_cents ?? 0,
      miles,
    });
  } catch (err) {
    console.error("[delivery] quote creation failed:", err);
    return {
      ok: false,
      error: "unavailable",
      message:
        "We could not get a delivery quote right now. Please try again in a moment, or choose pickup.",
    };
  }
  const expiresAt =
    created.expires_at ?? new Date(Date.now() + 10 * 60000).toISOString();
  try {
    const supabase = getServiceClient();
    const { data, error } = await supabase
      .from("delivery_quotes")
      .insert({
        quote_id: created.external_delivery_id,
        provider_mode: created.provider_mode,
        fee_cents: created.fee_cents,
        miles: Math.round(miles * 100) / 100,
        dropoff_address: input.address,
        dropoff_phone: input.phone ?? null,
        dropoff_name: input.name ?? null,
        expires_at: expiresAt,
      })
      .select("*")
      .single();
    if (error || !data) throw error ?? new Error("quote insert failed");
    return {
      ok: true,
      quote: data as StoredQuote,
      markup_cents: markupFor(created.fee_cents, settings),
      estimated_dropoff_at: created.estimated_dropoff_at,
      provider_mode: created.provider_mode,
    };
  } catch (err) {
    // delivery_quotes missing (stage3-schema.sql not run yet) or DB down:
    // clean customer-facing error, never a crash.
    console.error("[delivery] quote could not be stored:", err);
    return {
      ok: false,
      error: "unavailable",
      message:
        "Delivery is being set up right now. Please try again shortly, or choose pickup.",
    };
  }
}

export async function loadStoredQuote(quoteRowId: string): Promise<StoredQuote | null> {
  try {
    const supabase = getServiceClient();
    const { data, error } = await supabase
      .from("delivery_quotes")
      .select("*")
      .eq("id", quoteRowId)
      .maybeSingle();
    if (error || !data) return null;
    return data as StoredQuote;
  } catch {
    return null;
  }
}

export function normalizeAddress(address: string): string {
  return address
    .toLowerCase()
    .replace(/[.,#]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export type QuoteCheck =
  | { ok: true; quote: StoredQuote }
  | { ok: false; reason: "missing" | "expired" | "address_mismatch"; quote: StoredQuote | null };

/** Checkout-time verification: the stored quote is the ONLY fee source. */
export async function verifyQuoteForCheckout(
  quoteRowId: string,
  checkoutAddress: string
): Promise<QuoteCheck> {
  const quote = await loadStoredQuote(quoteRowId);
  if (!quote) return { ok: false, reason: "missing", quote: null };
  if (new Date(quote.expires_at).getTime() <= Date.now()) {
    return { ok: false, reason: "expired", quote };
  }
  if (normalizeAddress(quote.dropoff_address) !== normalizeAddress(checkoutAddress)) {
    return { ok: false, reason: "address_mismatch", quote };
  }
  return { ok: true, quote };
}

// ---- Order delivery state ---------------------------------------------------------

export interface DeliveryOrderLike {
  id: number;
  customer_name: string | null;
  customer_phone: string | null;
  fulfillment: string;
  delivery_address: string | null;
  items_json: { name: string; qty: number }[];
  subtotal_cents: number;
  tip_cents: number;
  delivery_external_id?: string | null;
  delivery_quote_id?: string | null;
  delivery_status?: string | null;
}

interface DeliveryPatch {
  delivery_provider?: string;
  delivery_external_id?: string;
  delivery_status?: string;
  delivery_error?: string | null;
  delivery_status_at?: string;
}

/** Writes delivery_* columns; swallows "column missing" (SQL not run). */
async function updateOrderDelivery(orderId: number, patch: DeliveryPatch): Promise<void> {
  try {
    const supabase = getServiceClient();
    const { error } = await supabase.from("orders").update(patch).eq("id", orderId);
    if (error) {
      if (/delivery_/i.test(error.message)) {
        console.warn(
          "[delivery] orders.delivery_* columns missing — run supabase/stage3-schema.sql"
        );
      } else {
        console.error("[delivery] order update failed:", error.message);
      }
    }
  } catch (err) {
    console.error("[delivery] order update failed:", err);
  }
}

/**
 * Dispatch after payment (called from markOrderPaid and the admin
 * Retry action). Idempotent: an order that already has a
 * delivery_external_id is never dispatched twice. On failure the
 * order stays PAID with delivery_status 'pending' + delivery_error,
 * ready for the admin Retry button.
 */
export async function dispatchDeliveryForOrder(
  order: DeliveryOrderLike
): Promise<{ ok: boolean; already?: boolean; error?: string }> {
  if (order.fulfillment !== "delivery") return { ok: false, error: "not a delivery order" };
  if (order.delivery_external_id) return { ok: true, already: true };
  const quote = order.delivery_quote_id
    ? await loadStoredQuote(order.delivery_quote_id)
    : null;
  const externalId = quote?.quote_id ?? `order-${order.id}`;
  try {
    const result = await dispatchDoorDashDelivery({
      external_delivery_id: externalId,
      dropoff_address: order.delivery_address ?? quote?.dropoff_address ?? "",
      dropoff_phone: order.customer_phone ?? quote?.dropoff_phone ?? "",
      dropoff_name: order.customer_name ?? undefined,
      order_value_cents: order.subtotal_cents,
      tip_cents: order.tip_cents,
      miles: quote?.miles ?? 0,
      items: (order.items_json ?? []).map((i) => ({ name: i.name, qty: i.qty })),
    });
    await updateOrderDelivery(order.id, {
      delivery_provider: "doordash",
      delivery_external_id: result.external_delivery_id,
      delivery_status: result.delivery_status,
      delivery_error: null,
      delivery_status_at: new Date().toISOString(),
    });
    // The live-map link rides in its own fail-soft update: until
    // supabase/live-tracking-schema.sql runs, that column does not
    // exist, and a missing column must never fail the dispatch save.
    if (result.tracking_url) {
      await saveDeliveryTrackingUrl(order.id, result.tracking_url);
    }
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Delivery dispatch failed";
    await updateOrderDelivery(order.id, {
      delivery_provider: "doordash",
      delivery_status: "pending",
      delivery_error: message.slice(0, 500),
      delivery_status_at: new Date().toISOString(),
    });
    console.error(`[delivery] dispatch for order #${order.id} failed:`, message);
    return { ok: false, error: message };
  }
}

/**
 * Applies a raw DoorDash status to an order (webhook + refresh share
 * this). Sends the "delivered" SMS exactly once, on the transition.
 */
export async function applyDeliveryStatus(
  order: { id: number; customer_phone: string | null; fulfillment: string; delivery_status?: string | null },
  rawStatus: string
): Promise<void> {
  const status = rawStatus.toLowerCase().trim();
  if (!status) return;
  const previous = (order.delivery_status ?? "").toLowerCase();
  if (previous === status) return;
  await updateOrderDelivery(order.id, {
    delivery_status: status,
    delivery_status_at: new Date().toISOString(),
  });
  if (status === "delivered" && previous !== "delivered") {
    try {
      await smsDeliveryDelivered(order);
    } catch (err) {
      console.error("[delivery] delivered SMS failed:", err);
    }
  }
  // "On its way" SMS — exactly once, on the heads-out transition
  // (the driver picked the food up / started toward the customer),
  // with the live tracking link: DoorDash's own map when we have
  // its URL, otherwise our track page (which shows the house
  // driver's live position). Statuses past heads-out don't refire.
  const WAY = ["picked_up", "enroute_to_dropoff", "out_for_delivery"];
  const WAY_OR_DONE = [...WAY, "arrived_at_dropoff", "delivered"];
  if (WAY.includes(status) && !WAY_OR_DONE.includes(previous)) {
    try {
      let link: string | null = null;
      try {
        const supabase = getServiceClient();
        const { data } = await supabase
          .from("orders")
          .select("delivery_provider, delivery_tracking_url")
          .eq("id", order.id)
          .maybeSingle();
        const row = data as {
          delivery_provider?: string | null;
          delivery_tracking_url?: string | null;
        } | null;
        if (row?.delivery_provider === "doordash" && row?.delivery_tracking_url) {
          link = row.delivery_tracking_url;
        }
      } catch {
        /* no stored link — the SMS falls back to the track page */
      }
      await smsDeliveryOnItsWay(order, link);
    } catch (err) {
      console.error("[delivery] on-its-way SMS failed:", err);
    }
  }
}

/**
 * Stores DoorDash's live-map URL on the order (live tracking,
 * 2026-11-23). Deliberately its own tiny update: until
 * supabase/live-tracking-schema.sql runs the column does not exist,
 * and that must never disturb the main delivery updates. Silent on
 * failure — tracking is a bonus, never a blocker.
 */
export async function saveDeliveryTrackingUrl(
  orderId: number,
  url: string | null | undefined
): Promise<void> {
  if (!url || !url.startsWith("http")) return;
  try {
    const supabase = getServiceClient();
    await supabase
      .from("orders")
      .update({ delivery_tracking_url: url })
      .eq("id", orderId);
  } catch {
    /* column missing or transient — ignore */
  }
}

/** saveDeliveryTrackingUrl for callers that only know the DoorDash id. */
export async function saveTrackingUrlByExternalId(
  externalId: string,
  url: string | null | undefined
): Promise<void> {
  if (!externalId || !url || !url.startsWith("http")) return;
  try {
    const supabase = getServiceClient();
    await supabase
      .from("orders")
      .update({ delivery_tracking_url: url })
      .eq("delivery_external_id", externalId);
  } catch {
    /* ignore */
  }
}

/** Finds the order for a DoorDash external id and applies a status. */
export async function applyDeliveryStatusByExternalId(
  externalId: string,
  rawStatus: string
): Promise<boolean> {
  try {
    const supabase = getServiceClient();
    const { data, error } = await supabase
      .from("orders")
      .select("id, customer_phone, fulfillment, delivery_status")
      .eq("delivery_external_id", externalId)
      .maybeSingle();
    if (error || !data) return false;
    await applyDeliveryStatus(data as DeliveryOrderLike, rawStatus);
    return true;
  } catch {
    return false;
  }
}

/**
 * Shipday webhook counterpart of applyDeliveryStatusByExternalId:
 * finds the order by its Shipday id (falling back to Shipday's
 * order_number, which is OUR order id), records the raw Shipday text
 * on shipday_status, and applies the canonical status through the
 * shared path (so the delivered SMS fires exactly once, as with
 * DoorDash). An order explicitly recorded as a DoorDash order is
 * never touched. Returns false when nothing matched.
 */
export async function applyShipdayStatus(input: {
  shipdayId: string;
  orderNumber: string;
  rawStatus: string;
  canonical: string;
}): Promise<boolean> {
  try {
    const supabase = getServiceClient();
    let order: Record<string, unknown> | null = null;
    if (input.shipdayId) {
      const { data } = await supabase
        .from("orders")
        .select("id, customer_phone, fulfillment, delivery_status, delivery_provider")
        .eq("shipday_order_id", input.shipdayId)
        .maybeSingle();
      order = (data as Record<string, unknown>) ?? null;
    }
    if (!order && input.orderNumber && /^\d+$/.test(input.orderNumber)) {
      const { data } = await supabase
        .from("orders")
        .select("id, customer_phone, fulfillment, delivery_status, delivery_provider")
        .eq("id", Number(input.orderNumber))
        .maybeSingle();
      const candidate = (data as Record<string, unknown>) ?? null;
      if (
        candidate &&
        candidate.fulfillment === "delivery" &&
        candidate.delivery_provider !== "doordash"
      ) {
        order = candidate;
      }
    }
    if (!order) return false;
    if (input.rawStatus) {
      try {
        await supabase
          .from("orders")
          .update({ shipday_status: `Shipday: ${input.rawStatus}`.slice(0, 200) })
          .eq("id", order.id as number);
      } catch {
        /* the canonical status below is what matters */
      }
    }
    await applyDeliveryStatus(
      order as { id: number; customer_phone: string | null; fulfillment: string; delivery_status?: string | null },
      input.canonical
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Staff "Refresh status": live mode asks DoorDash for the current
 * status; mock mode advances the simulated lifecycle one step.
 * Returns the latest raw status (or null when nothing changed).
 */
export async function refreshDeliveryStatus(
  order: DeliveryOrderLike
): Promise<{ ok: boolean; status: string | null; error?: string }> {
  if (!order.delivery_external_id) {
    return { ok: false, status: null, error: "No delivery has been created for this order yet." };
  }
  if (doordashMode() === "live") {
    try {
      const current = await getDoorDashDelivery(order.delivery_external_id);
      if (!current) return { ok: false, status: null, error: "DoorDash returned no status." };
      await applyDeliveryStatus(order, current.delivery_status);
      if (current.tracking_url) {
        await saveDeliveryTrackingUrl(order.id, current.tracking_url);
      }
      return { ok: true, status: current.delivery_status };
    } catch (err) {
      return {
        ok: false,
        status: null,
        error: err instanceof Error ? err.message : "Status refresh failed",
      };
    }
  }
  const next = mockNextStatus(order.delivery_status ?? "created");
  if (!next) return { ok: true, status: order.delivery_status ?? null };
  await applyDeliveryStatus(order, next);
  return { ok: true, status: next };
}

// ---- House Delivery -------------------------------------------------------------

/**
 * House Delivery "dispatch" (markOrderPaid calls this instead of an
 * external dispatch): there is NO external service — the order is
 * simply marked as a house order awaiting the restaurant's own
 * driver, and it gets its unguessable driver-page token if it does
 * not have one yet. Fail-soft like everything else here: if the
 * driver_token column does not exist yet
 * (supabase/house-delivery-schema.sql not run), the order is still
 * registered, just without a token (no driver QR until it exists).
 */
export async function registerHouseDelivery(order: {
  id: number;
  driver_token?: string | null;
}): Promise<void> {
  const patch: Record<string, unknown> = {
    delivery_provider: "house",
    delivery_status: "pending",
    delivery_error: null,
    delivery_status_at: new Date().toISOString(),
  };
  if (!order.driver_token) {
    patch.driver_token = randomBytes(16).toString("hex");
  }
  try {
    const supabase = getServiceClient();
    let { error } = await supabase.from("orders").update(patch).eq("id", order.id);
    if (error && /driver_token/i.test(error.message)) {
      delete patch.driver_token;
      ({ error } = await supabase.from("orders").update(patch).eq("id", order.id));
    }
    if (error) {
      console.error("[delivery] house registration failed:", error.message);
    }
  } catch (err) {
    console.error("[delivery] house registration failed:", err);
  }
}

export interface DriverOrder {
  id: number;
  customer_name: string | null;
  customer_phone: string | null;
  fulfillment: string;
  payment_status: string;
  delivery_address: string | null;
  delivery_provider: string | null;
  delivery_status: string | null;
  items_json: { name: string; qty: number; line_total_cents: number }[];
  total_cents: number;
  note?: string | null;
}

/** The order behind a driver-page token (null when unknown). */
export async function getOrderByDriverToken(token: string): Promise<DriverOrder | null> {
  if (!/^[a-f0-9]{32,64}$/.test(token)) return null;
  try {
    const supabase = getServiceClient();
    const { data, error } = await supabase
      .from("orders")
      .select("*")
      .eq("driver_token", token)
      .maybeSingle();
    if (error || !data) return null;
    const order = data as DriverOrder;
    if (order.delivery_provider !== "house") return null;
    return order;
  } catch {
    return null;
  }
}

/**
 * The driver tapped "Delivered ✓" on /d/<token>: applies the shared
 * delivered path (status + the customer's delivered SMS, exactly
 * once). Returns false when the token does not name a house order.
 */
export async function markHouseDelivered(token: string): Promise<boolean> {
  const order = await getOrderByDriverToken(token);
  if (!order) return false;
  if (order.delivery_status !== "delivered") {
    await applyDeliveryStatus(
      {
        id: order.id,
        customer_phone: order.customer_phone,
        fulfillment: order.fulfillment,
        delivery_status: order.delivery_status,
      },
      "delivered"
    );
  }
  // House delivery is finished end-to-end when the driver confirms:
  // also close the kitchen side so the card leaves the board on its
  // own. Quiet update only — no "ready" SMS or TV flow; the customer
  // already received the delivered SMS from applyDeliveryStatus.
  // Best-effort: if it fails, the kitchen can still tap the card.
  try {
    const supabase = getServiceClient();
    await supabase
      .from("orders")
      .update({ kitchen_status: "completed" })
      .eq("id", order.id)
      .not("kitchen_status", "in", "(completed,cancelled)");
  } catch (err) {
    console.error("[delivery] house kitchen auto-complete failed:", err);
  }
  return true;
}

/**
 * House Delivery live tracking: the driver page posts the phone's
 * GPS here (via /api/driver-location) while the delivery runs. The
 * first accepted post flips the order to 'out_for_delivery' through
 * the shared status path — the customer's timeline advances and the
 * exactly-once on-its-way SMS fires with the track-page link (the
 * track page and the admin panel draw the live map from these
 * columns). Posts for a delivered order are acknowledged but
 * ignored, so the driver app can stop itself. Fail-soft: until
 * supabase/live-tracking-schema.sql runs, the update errors and
 * this returns { ok: false } without touching the status.
 */
export async function updateDriverLocation(
  token: string,
  lat: number,
  lng: number
): Promise<{ ok: boolean; status?: string }> {
  const order = await getOrderByDriverToken(token);
  if (!order) return { ok: false };
  if (order.delivery_status === "delivered") {
    return { ok: true, status: "delivered" };
  }
  try {
    const supabase = getServiceClient();
    const { error } = await supabase
      .from("orders")
      .update({
        driver_lat: lat,
        driver_lng: lng,
        driver_loc_at: new Date().toISOString(),
      })
      .eq("id", order.id);
    if (error) {
      console.warn("[delivery] driver location save failed:", error.message);
      return { ok: false };
    }
  } catch (err) {
    console.error("[delivery] driver location save failed:", err);
    return { ok: false };
  }
  let status = order.delivery_status ?? "pending";
  if (status !== "out_for_delivery") {
    await applyDeliveryStatus(
      {
        id: order.id,
        customer_phone: order.customer_phone,
        fulfillment: order.fulfillment,
        delivery_status: order.delivery_status,
      },
      "out_for_delivery"
    );
    status = "out_for_delivery";
  }
  return { ok: true, status };
}
