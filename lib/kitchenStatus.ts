// Kitchen status model — ONE-TAP FLOW (owner's design, 2026-11-18).
//
// The database keeps the full legacy lifecycle in orders.kitchen_status
// ('new' | 'accepted' | 'preparing' | 'ready' | 'completed' |
// 'cancelled'), but the staff and customer UX has exactly two beats:
//
//   1. AUTO-ACCEPT — the moment an order is paid it is "Accepted"
//      (markOrderPaid flips 'new' -> 'accepted'; no staff action).
//   2. ONE TAP — the chef taps the top of the kitchen card when the
//      food is ready; the order becomes 'completed' internally, leaves
//      the board, the customer gets the pickup-ready SMS, and the TV
//      board shows it as READY (the board feed maps recent completions
//      to 'ready', as before).
//
// There are no Accept / Preparing / Ready / Done steps anywhere in the
// UI anymore. These pure helpers are the single source of truth for
// how a raw kitchen_status is PRESENTED and which transitions have
// side effects, so the kitchen feed, the admin panel and the status
// routes can never drift apart. No imports — safe in client components
// and in the node test harness.

/** Statuses that keep an order on the active kitchen board. */
export const ACTIVE_KITCHEN_STATUSES = [
  "new",
  "accepted",
  "preparing",
  "ready",
] as const;

/** Legacy in-progress statuses that all mean "Accepted" in the new UX. */
const IN_PROGRESS_STATUSES: readonly string[] = [
  "new",
  "accepted",
  "preparing",
  "ready",
];

export function isPaidStatus(paymentStatus: string): boolean {
  return paymentStatus === "paid" || paymentStatus === "test_paid";
}

/**
 * Status shown by the KITCHEN FEED for one order. Paid orders that are
 * still in any in-progress state are presented as 'accepted' — this is
 * what makes orders paid BEFORE the auto-accept deploy (still sitting
 * at 'new' / 'preparing' / 'ready' in the database) show up correctly
 * as Accepted with no staff action and no data migration. Unpaid,
 * completed and cancelled orders pass through unchanged.
 */
export function feedKitchenStatus(order: {
  payment_status: string;
  kitchen_status: string;
}): string {
  if (
    isPaidStatus(order.payment_status) &&
    IN_PROGRESS_STATUSES.includes(order.kitchen_status)
  ) {
    return "accepted";
  }
  return order.kitchen_status;
}

/**
 * The ready-SMS rule, shared by /api/kitchen/status and the
 * admin panel's set_order_status. The text fires EXACTLY ONCE per
 * order: on the first transition INTO 'ready' or 'completed' (the
 * one-tap completion), and never again — not on a repeat tap, not when
 * a legacy 'ready' order is later completed (it was already texted
 * when it became ready), and never for delivery orders. Pickup AND
 * curbside orders get the text (curbside with its own wording — see
 * lib/sms.ts).
 */
export function shouldSendReadySms(
  prevStatus: string,
  nextStatus: string,
  fulfillment: string
): boolean {
  if (fulfillment !== "pickup" && fulfillment !== "curbside") return false;
  const intoReadyState = nextStatus === "ready" || nextStatus === "completed";
  const alreadyReadyState = prevStatus === "ready" || prevStatus === "completed";
  return intoReadyState && !alreadyReadyState;
}

/**
 * The one status label the admin panel shows for an order:
 * "Accepted" from payment until the kitchen tap, then "Completed".
 * Legacy in-progress statuses of paid orders all read "Accepted";
 * an order that has not been paid yet reads "New".
 */
export function adminStatusLabel(order: {
  payment_status: string;
  kitchen_status: string;
}): string {
  if (order.kitchen_status === "cancelled") return "Cancelled";
  if (order.kitchen_status === "completed") return "Completed";
  if (isPaidStatus(order.payment_status)) return "Accepted";
  return "New";
}

/**
 * Maps the admin Orders status filter to the raw kitchen_status values
 * it matches. "Accepted" covers every legacy in-progress status so old
 * orders are never hidden by the simplified filter. Returns null for
 * "all" / unknown values (no status constraint).
 */
export function statusFilterStatuses(
  filter: string | undefined
): string[] | null {
  switch (filter) {
    case "accepted":
      return [...IN_PROGRESS_STATUSES];
    case "completed":
      return ["completed"];
    case "cancelled":
      return ["cancelled"];
    default:
      return null;
  }
}
