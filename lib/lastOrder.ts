// The just-placed order snapshot the storefront keeps in
// sessionStorage (tab-scoped) under "mm_last_order". It is written by
// placeOrder in components/Storefront.tsx as
// { id, fulfillment, phone, car } so the confirmation banner can offer
// the curbside "I'm here" button after the Stripe redirect.
//
// The track page reads the SAME snapshot for one-tap tracking
// (usability item 5): when the customer taps "Track your order →" on
// the confirmation banner, the phone is already in this tab, so the
// lookup can run at once — no typing. The phone is never put in a URL,
// never sent anywhere new, and vanishes when the tab closes.

export const LAST_ORDER_KEY = "mm_last_order";

export interface LastOrderSnapshot {
  id: number;
  phone: string;
}

/** Tolerant parse of the raw sessionStorage value; null on anything odd. */
export function parseLastOrderSnapshot(
  raw: string | null
): LastOrderSnapshot | null {
  if (!raw) return null;
  try {
    const saved = JSON.parse(raw) as { id?: unknown; phone?: unknown };
    if (
      typeof saved.id === "number" &&
      saved.id > 0 &&
      typeof saved.phone === "string" &&
      saved.phone.trim().length > 0
    ) {
      return { id: saved.id, phone: saved.phone };
    }
  } catch {
    /* not JSON — no usable snapshot */
  }
  return null;
}

/**
 * One-tap tracking decision: given the ?order= value from the track
 * page URL and the raw sessionStorage snapshot, return the pair to
 * auto-lookup once on load, or null to show the plain form exactly as
 * before (direct visit, new tab, or no saved phone).
 */
export function resolveTrackAutoLookup(
  orderParam: string | null,
  rawSnapshot: string | null
): { orderId: string; phone: string } | null {
  if (!orderParam || !orderParam.trim()) return null;
  const saved = parseLastOrderSnapshot(rawSnapshot);
  if (!saved) return null;
  return { orderId: orderParam, phone: saved.phone };
}
