// Pure DoorDash status display helpers — NO imports, safe for client
// components (track page, admin panel) as well as the server.

/** Customer-facing label for a raw DoorDash delivery status. */
export function deliveryStatusLabel(raw: string | null | undefined): string {
  switch ((raw ?? "").toLowerCase()) {
    case "pending":
      return "Delivery is being arranged";
    case "created":
      return "Order confirmed — finding a driver";
    case "confirmed":
      return "Driver assigned";
    case "enroute_to_pickup":
      return "Driver heading to the restaurant";
    case "arrived_at_pickup":
      return "Driver at the restaurant";
    case "picked_up":
      return "Picked up — on the way";
    case "enroute_to_dropoff":
    case "out_for_delivery":
      return "On the way to you";
    case "arrived_at_dropoff":
      return "Driver has arrived";
    case "delivered":
      return "Delivered";
    case "cancelled":
      return "Delivery cancelled";
    case "failed":
      return "Delivery failed";
    default:
      return raw ? String(raw) : "—";
  }
}

/**
 * Maps a raw DoorDash status to the customer timeline position
 * (0 received · 1 preparing · 2 on the way · 3 delivered).
 * Returns null when the kitchen status should drive the timeline.
 */
export function deliveryStepIndex(raw: string | null | undefined): number | null {
  switch ((raw ?? "").toLowerCase()) {
    case "delivered":
      return 3;
    case "picked_up":
    case "enroute_to_dropoff":
    case "out_for_delivery":
    case "arrived_at_dropoff":
      return 2;
    default:
      return null;
  }
}

/** True for terminal delivery states that need a call-us message. */
export function deliveryIsFailed(raw: string | null | undefined): boolean {
  const s = (raw ?? "").toLowerCase();
  return s === "cancelled" || s === "failed";
}
