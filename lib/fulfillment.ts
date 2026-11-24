// Fulfillment model — pickup / curbside / delivery.
//
// Curbside (2026-11-20) is the third fulfillment type: the customer
// orders online, drives over, taps "I'm here" on the confirmation /
// tracking page, and staff carry the bag out to the car.
//
// The money rule is absolute: CURBSIDE IS PICKUP FOR MONEY. No
// delivery fee, no DoorDash quote, no dispatch — tax, service fee and
// tip are computed exactly as for pickup. Curbside is its own type
// only for DISPLAY and routing: checkout choice, kitchen badge, the
// ready-SMS wording, the Fresh KDS mode string and the admin views.
//
// Pure helpers, no imports — the single source of truth shared by the
// checkout route, the storefront, Fresh KDS, the "I'm here" endpoint
// and the node test harness, so the paths can never drift apart.

export type Fulfillment = "pickup" | "curbside" | "delivery";

/**
 * Normalizes a client-sent (or stored) fulfillment value. Anything
 * unrecognized falls back to "pickup" — the pre-curbside behavior for
 * delivery-vs-pickup is preserved exactly.
 */
export function normalizeFulfillment(value: unknown): Fulfillment {
  if (value === "delivery") return "delivery";
  if (value === "curbside") return "curbside";
  return "pickup";
}

export function isCurbside(fulfillment: string): boolean {
  return fulfillment === "curbside";
}

/**
 * ONLY delivery ever enters the DoorDash quote path. Curbside must
 * never require, accept or store a delivery quote — its delivery fee
 * is always $0, exactly like pickup.
 */
export function needsDeliveryQuote(fulfillment: string): boolean {
  return fulfillment === "delivery";
}

/** The Fresh KDS "mode" string for an order (API enum, exact case). */
export function freshKdsMode(fulfillment: string): "Pickup" | "Curbside" | "Delivery" {
  if (fulfillment === "delivery") return "Delivery";
  if (fulfillment === "curbside") return "Curbside";
  return "Pickup";
}

/**
 * Whether the checkout offers Curbside: only when the admin switch is
 * ON. The setting defaults ON (lib/admin DEFAULT_SETTINGS), and a
 * missing value in an older payload also reads as ON — only an
 * explicit false hides the choice.
 */
export function checkoutOffersCurbside(settings: {
  curbside_enabled?: boolean;
}): boolean {
  return settings.curbside_enabled !== false;
}

// ---- "I'm here" -----------------------------------------------------------------

export interface HereOrderState {
  fulfillment: string;
  payment_status: string;
  kitchen_status: string;
  customer_here_at?: string | null;
}

export type HereDecision =
  | { action: "set"; at: string }
  | { action: "already"; at: string }
  | { action: "reject"; reason: string };

/**
 * The "I'm here" rule (pure). The first tap on a paid, still-active
 * curbside order records the arrival time; every later tap is a no-op
 * that reports the ORIGINAL time — the recorded time never moves.
 * Anything else (not curbside, unpaid, completed, cancelled) is
 * rejected with a machine-readable reason for the endpoint.
 */
export function decideCustomerHere(
  order: HereOrderState,
  nowIso: string
): HereDecision {
  if (order.fulfillment !== "curbside") return { action: "reject", reason: "not_curbside" };
  if (order.payment_status !== "paid" && order.payment_status !== "test_paid") {
    return { action: "reject", reason: "not_paid" };
  }
  if (order.kitchen_status === "completed" || order.kitchen_status === "cancelled") {
    return { action: "reject", reason: "order_closed" };
  }
  if (order.customer_here_at) {
    return { action: "already", at: order.customer_here_at };
  }
  return { action: "set", at: nowIso };
}
