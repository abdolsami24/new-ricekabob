// Pure fee math for the Service Fee + Free Delivery promotion — NO
// imports, so the numbers can be unit-checked with plain node + tsc
// (same pattern as lib/deliveryPricing.ts). All money is integer cents.
//
// SERVICE FEE (Admin → Operations): a general fee on EVERY order
// (pickup and delivery), chosen by the admin as either a percent of
// the food subtotal or a flat amount per order. It is NOT a delivery
// charge and is never waived by the free-delivery promotion. It is
// NOT taxed — sales tax stays 8% of the food subtotal, computed in
// lib/pricing.ts exactly as before.
//
// FREE DELIVERY (Admin → Promotions): when enabled, a delivery order
// whose food subtotal reaches the admin's threshold pays $0 for
// delivery. The DoorDash quote is still created and stored (the
// courier must be dispatched); the restaurant absorbs its fee.

export interface ServiceFeeConfig {
  enabled: boolean;
  /** 'percent' = % of the food subtotal · 'flat' = fixed cents per order. */
  type: "percent" | "flat";
  /** Percent of the food subtotal (0–100, may be fractional, e.g. 2.5). */
  percent: number;
  /** Flat amount per order, cents. */
  flat_cents: number;
}

export const DEFAULT_SERVICE_FEE: ServiceFeeConfig = {
  enabled: false,
  type: "percent",
  percent: 0,
  flat_cents: 0,
};

/**
 * The service fee for an order, in cents. Percent fees round to the
 * NEAREST cent (Math.round — a half cent rounds up). Disabled or
 * zero-valued configs charge nothing.
 */
export function computeServiceFeeCents(
  subtotalCents: number,
  cfg: ServiceFeeConfig
): number {
  if (!cfg.enabled) return 0;
  const subtotal = Number.isFinite(subtotalCents) ? Math.max(0, Math.round(subtotalCents)) : 0;
  if (cfg.type === "flat") {
    return Number.isFinite(cfg.flat_cents) ? Math.max(0, Math.round(cfg.flat_cents)) : 0;
  }
  const pct = Number.isFinite(cfg.percent) ? Math.min(Math.max(cfg.percent, 0), 100) : 0;
  return Math.round((subtotal * pct) / 100);
}

export interface FreeDeliveryConfig {
  enabled: boolean;
  /** Food subtotal (cents) at or above which delivery is free. */
  threshold_cents: number;
}

export const DEFAULT_FREE_DELIVERY: FreeDeliveryConfig = {
  enabled: false,
  threshold_cents: 0,
};

/**
 * True when the free-delivery promotion applies to an order with this
 * food subtotal. The threshold is inclusive (an order of exactly $X
 * qualifies — "orders over $50" in the owner's wording includes the
 * order that reaches $50.00). A $0 threshold never applies: it can
 * only be a misconfiguration, and free delivery for every order must
 * be a deliberate choice with a real amount.
 */
export function freeDeliveryApplies(
  subtotalCents: number,
  cfg: FreeDeliveryConfig
): boolean {
  if (!cfg.enabled) return false;
  if (!Number.isFinite(cfg.threshold_cents) || cfg.threshold_cents <= 0) return false;
  const subtotal = Number.isFinite(subtotalCents) ? Math.round(subtotalCents) : 0;
  return subtotal >= Math.round(cfg.threshold_cents);
}

/**
 * The single "Delivery fee" amount the CUSTOMER pays: the DoorDash
 * quote fee plus the restaurant's extra delivery markup, merged into
 * one line (the split stays visible in the admin panel only). $0 when
 * the free-delivery promotion applies.
 */
export function customerDeliveryCents(
  quoteFeeCents: number,
  markupCents: number,
  freeApplied: boolean
): number {
  if (freeApplied) return 0;
  const fee = Number.isFinite(quoteFeeCents) ? Math.max(0, Math.round(quoteFeeCents)) : 0;
  const markup = Number.isFinite(markupCents) ? Math.max(0, Math.round(markupCents)) : 0;
  return fee + markup;
}
