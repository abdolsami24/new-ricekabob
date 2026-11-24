// Owner order-notification email — best-effort, never blocks an order.
// If EMAIL_API_URL + EMAIL_API_KEY are set (for example a Resend-style HTTP
// API that accepts {from, to, subject, text}), the email is sent through it.
// The sender is EMAIL_FROM (default: Madinah Market <orders@taqwaacenter.com>).
// Otherwise the email is written to the server log so nothing is silently lost.

import { formatCents } from "./menu";

export interface NotifyOrder {
  id: number;
  customer_name: string | null;
  customer_phone: string | null;
  fulfillment: string;
  delivery_address: string | null;
  /** Curbside: the customer's car (absent until curbside-schema.sql). */
  car_description?: string | null;
  /** Order-level checkout note (absent until order-note-schema.sql). */
  note?: string | null;
  items_json: { name: string; qty: number; line_total_cents: number }[];
  subtotal_cents: number;
  /** General Service Fee charged on the order (0 when off). */
  service_fee_cents?: number;
  tax_cents: number;
  delivery_fee_cents: number;
  /** Stage 3: the restaurant's extra delivery markup, if any. */
  delivery_markup_cents?: number;
  /** True when the Free Delivery promotion zeroed the delivery charge. */
  free_delivery?: boolean;
  tip_cents: number;
  total_cents: number;
  payment_status: string;
}

export async function notifyOwner(order: NotifyOrder): Promise<void> {
  const to = process.env.OWNER_NOTIFICATION_EMAIL || "Abdolsami@yahoo.com";
  const subject = `Madinah Market — New ${order.fulfillment} order #${order.id} (${formatCents(
    order.total_cents
  )})`;
  const lines = (order.items_json ?? [])
    .map((l) => `  ${l.qty} x ${l.name} — ${formatCents(l.line_total_cents)}`)
    .join("\n");
  const text = [
    `New order #${order.id} — ${order.fulfillment.toUpperCase()} (${order.payment_status})`,
    `Customer: ${order.customer_name ?? "-"}  Phone: ${order.customer_phone ?? "-"}`,
    order.note?.trim() ? `Note: ${order.note.trim()}` : "",
    order.fulfillment === "delivery" ? `Delivery address: ${order.delivery_address ?? "-"}` : "",
    order.fulfillment === "curbside"
      ? `Car (curbside): ${order.car_description ?? "-"}`
      : "",
    "",
    "Items:",
    lines,
    "",
    `Subtotal: ${formatCents(order.subtotal_cents)}`,
    (order.service_fee_cents ?? 0) > 0
      ? `Service fee: ${formatCents(order.service_fee_cents ?? 0)}`
      : "",
    `Tax (8%): ${formatCents(order.tax_cents)}`,
    // One merged delivery line (DoorDash fee + extra markup), FREE
    // when the Free Delivery promotion applied.
    order.fulfillment === "delivery" && order.free_delivery
      ? "Delivery fee: FREE (promotion)"
      : order.delivery_fee_cents + (order.delivery_markup_cents ?? 0) > 0
        ? `Delivery fee: ${formatCents(
            order.delivery_fee_cents + (order.delivery_markup_cents ?? 0)
          )}`
        : "",
    order.tip_cents > 0 ? `Tip: ${formatCents(order.tip_cents)}` : "",
    `TOTAL: ${formatCents(order.total_cents)}`,
  ]
    .filter(Boolean)
    .join("\n");

  const apiUrl = process.env.EMAIL_API_URL;
  const apiKey = process.env.EMAIL_API_KEY;
  const from = process.env.EMAIL_FROM || "Madinah Market <orders@taqwaacenter.com>";
  if (apiUrl && apiKey) {
    try {
      await fetch(apiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          from,
          to,
          subject,
          text,
        }),
      });
      return;
    } catch (err) {
      console.error("[owner-email] send failed, falling back to log:", err);
    }
  }
  console.log(`[owner-email] To: ${to}\nSubject: ${subject}\n${text}`);
}
