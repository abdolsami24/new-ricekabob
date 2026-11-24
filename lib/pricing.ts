// Money rules for Madinah Market. ALL money is integer cents.
// - Sales tax: 8% of subtotal (TAX_RATE env, default 0.08), rounded to cent.
// - Tip: percent of subtotal (0-30%) or a custom amount capped at $200.00.
// - Delivery fee: straight-line distance bands from the restaurant.

import { MENU_BY_ID, type MenuItem } from "./menu";
import {
  validateSelectedOptions,
  optionsSignature,
  type SelectedOption,
} from "./menuOptions";

export interface OrderLine {
  id: string;
  name: string;
  qty: number;
  /** Base dish price in cents (before options). */
  unit_price_cents: number;
  /** Chosen add-ons/removals, priced from the server's menu data. */
  options?: SelectedOption[];
  /** Per-dish special instructions from the customer. */
  instructions?: string;
  line_total_cents: number;
}

export interface Totals {
  subtotal_cents: number;
  discount_cents: number;
  /** General Service Fee (lib/feePricing.ts) — never taxed. */
  service_fee_cents: number;
  tax_cents: number;
  delivery_fee_cents: number;
  tip_cents: number;
  total_cents: number;
}

export function taxRate(): number {
  const raw = Number(process.env.TAX_RATE ?? "0.08");
  return Number.isFinite(raw) && raw >= 0 && raw < 1 ? raw : 0.08;
}

export function taxFor(subtotal_cents: number): number {
  return Math.round(subtotal_cents * taxRate());
}

/** Distance bands: within N miles -> fee in cents. Beyond the last band, no delivery. */
export const DELIVERY_BANDS: { miles: number; fee_cents: number }[] = [
  { miles: 1, fee_cents: 699 },
  { miles: 2, fee_cents: 799 },
  { miles: 3, fee_cents: 899 },
  { miles: 4, fee_cents: 999 },
];

/** Returns the fee for a distance, or null when the address is out of area. */
export function deliveryFeeForMiles(miles: number): { fee_cents: number; band_miles: number } | null {
  if (!Number.isFinite(miles) || miles < 0) return null;
  for (const band of DELIVERY_BANDS) {
    if (miles <= band.miles) return { fee_cents: band.fee_cents, band_miles: band.miles };
  }
  return null;
}

/** Tip in cents from either a percent choice or a custom amount. Server-validated. */
export function computeTipCents(
  subtotal_cents: number,
  tip_percent?: number,
  tip_custom_cents?: number
): number {
  if (typeof tip_custom_cents === "number" && Number.isFinite(tip_custom_cents)) {
    return Math.min(Math.max(Math.round(tip_custom_cents), 0), 20000); // cap $200.00
  }
  if (typeof tip_percent === "number" && Number.isFinite(tip_percent)) {
    const pct = Math.min(Math.max(tip_percent, 0), 30); // 0-30%
    return Math.round((subtotal_cents * pct) / 100);
  }
  return 0;
}

/** One client-sent cart entry (prices in it are NEVER trusted). */
export interface CartInputLine {
  id: string;
  qty: number;
  options?: { group: string; name: string }[];
  instructions?: string;
}

/**
 * Builds trusted order lines from client-sent cart entries. Each entry
 * may carry option selections ({group, name} pairs) and special
 * instructions; options are priced from the server's own menu data and
 * unknown item/group/choice ids are rejected. Entries merge only when
 * the dish, the exact option set and the instructions all match —
 * the same dish with different options stays a separate line.
 */
export function buildLines(
  input: CartInputLine[],
  menuById: Record<string, MenuItem> = MENU_BY_ID
): OrderLine[] {
  if (!Array.isArray(input) || input.length === 0) throw new Error("Cart is empty");
  if (input.length > 50) throw new Error("Too many items");
  const merged = new Map<string, OrderLine>();
  for (const raw of input) {
    const id = String(raw?.id ?? "");
    const qty = Math.floor(Number(raw?.qty));
    const menuItem = menuById[id];
    if (!menuItem) throw new Error(`Unknown item: ${id}`);
    if (!Number.isFinite(qty) || qty < 1 || qty > 50) throw new Error(`Bad quantity for ${id}`);
    const options = validateSelectedOptions(menuItem.option_groups, raw?.options);
    if (options === null) throw new Error(`Unknown option for ${menuItem.name}`);
    const instructions =
      typeof raw?.instructions === "string" ? raw.instructions.trim().slice(0, 200) : "";
    const optionsTotal = options.reduce((s, o) => s + o.price_delta_cents, 0);
    const unitWithOptions = menuItem.price_cents + optionsTotal;
    const key = `${id}||${optionsSignature(options)}||${instructions}`;
    const existing = merged.get(key);
    if (existing) {
      existing.qty += qty;
      if (existing.qty > 50) throw new Error(`Bad quantity for ${id}`);
      existing.line_total_cents = unitWithOptions * existing.qty;
    } else {
      merged.set(key, {
        id,
        name: menuItem.name,
        qty,
        unit_price_cents: menuItem.price_cents,
        ...(options.length > 0 ? { options } : {}),
        ...(instructions ? { instructions } : {}),
        line_total_cents: unitWithOptions * qty,
      });
    }
  }
  return [...merged.values()];
}

export function computeTotals(
  lines: OrderLine[],
  delivery_fee_cents: number,
  tip_cents: number,
  discount_cents = 0,
  service_fee_cents = 0
): Totals {
  const subtotal_cents = lines.reduce((sum, l) => sum + l.line_total_cents, 0);
  // Loyalty discount comes off the subtotal BEFORE tax.
  const safe_discount = Math.min(Math.max(discount_cents, 0), subtotal_cents);
  // Tax is 8% of the (discounted) food subtotal ONLY — the service fee
  // is never taxed and never changes the tax amount.
  const tax_cents = taxFor(subtotal_cents - safe_discount);
  const safe_service_fee = Math.max(0, Math.round(service_fee_cents) || 0);
  return {
    subtotal_cents,
    discount_cents: safe_discount,
    service_fee_cents: safe_service_fee,
    tax_cents,
    delivery_fee_cents,
    tip_cents,
    total_cents:
      subtotal_cents -
      safe_discount +
      safe_service_fee +
      tax_cents +
      delivery_fee_cents +
      tip_cents,
  };
}
