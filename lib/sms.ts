// Customer SMS via Twilio — plain REST with fetch, no SDK dependency.
// If TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN + TWILIO_PHONE_NUMBER are
// not all set, every send is a no-op (mock mode) and the admin Security
// section reports Twilio as "not configured". SMS is ALWAYS
// best-effort: a failure is logged, never thrown — a text message must
// never break an order, a kitchen tap, or a webhook.

import { normalizePhone } from "./shipday";
import { siteUrl } from "./stripe";

export function twilioConfigured(): boolean {
  return Boolean(
    process.env.TWILIO_ACCOUNT_SID &&
      process.env.TWILIO_AUTH_TOKEN &&
      process.env.TWILIO_PHONE_NUMBER
  );
}

export async function sendSms(to: string, body: string): Promise<boolean> {
  if (!twilioConfigured()) return false;
  const phone = normalizePhone(to ?? "");
  if (phone.replace(/\D/g, "").length < 10) return false;
  try {
    const sid = process.env.TWILIO_ACCOUNT_SID!;
    const auth = Buffer.from(
      `${sid}:${process.env.TWILIO_AUTH_TOKEN!}`,
      "utf8"
    ).toString("base64");
    const res = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`,
      {
        method: "POST",
        headers: {
          Authorization: `Basic ${auth}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          To: phone,
          From: process.env.TWILIO_PHONE_NUMBER!,
          Body: body.slice(0, 1500),
        }).toString(),
      }
    );
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.error(`[sms] Twilio HTTP ${res.status}: ${text.slice(0, 300)}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error("[sms] send failed:", err);
    return false;
  }
}

interface SmsOrder {
  id: number;
  customer_phone: string | null;
  fulfillment: string;
}

export function trackUrl(orderId: number): string {
  return `${siteUrl()}/track?order=${orderId}`;
}

/** (a) Order paid/confirmed — sent once from markOrderPaid. */
export async function smsOrderConfirmed(order: SmsOrder): Promise<void> {
  if (!order.customer_phone) return;
  const kind =
    order.fulfillment === "delivery"
      ? "delivery"
      : order.fulfillment === "curbside"
        ? "curbside"
        : "pickup";
  await sendSms(
    order.customer_phone,
    `Madinah Market: Thank you! Your ${kind} order #${order.id} is confirmed. Track it here: ${trackUrl(order.id)}`
  );
}

/**
 * (b) Pickup / curbside order marked ready by the kitchen. The pickup
 * wording is unchanged; curbside tells the customer the food is being
 * brought out to their car.
 */
export async function smsPickupReady(order: SmsOrder): Promise<void> {
  if (!order.customer_phone) return;
  if (order.fulfillment === "curbside") {
    await sendSms(
      order.customer_phone,
      `Madinah Market: Good news — your order #${order.id} is READY and we're bringing it out to your car now. 🚗`
    );
    return;
  }
  await sendSms(
    order.customer_phone,
    `Madinah Market: Good news — your order #${order.id} is READY for pickup at 3126 S Parker Rd, Aurora. See you soon!`
  );
}

/**
 * (d) Delivery is on its way — sent exactly once, on the heads-out
 * transition in applyDeliveryStatus. The link is the provider's live
 * map when we have one (DoorDash), otherwise our own track page
 * (House Delivery shows the driver's live position there).
 */
export async function smsDeliveryOnItsWay(
  order: SmsOrder,
  link: string | null
): Promise<void> {
  if (!order.customer_phone) return;
  const url = link && link.startsWith("http") ? link : trackUrl(order.id);
  await sendSms(
    order.customer_phone,
    `Madinah Market: Good news — your order #${order.id} is on its way! Track it live here: ${url}`
  );
}

/** (c) Delivery order delivered (webhook / status refresh). */
export async function smsDeliveryDelivered(order: SmsOrder): Promise<void> {
  if (!order.customer_phone) return;
  await sendSms(
    order.customer_phone,
    `Madinah Market: Your order #${order.id} has been delivered. Enjoy your meal! Questions? Call 720-763-0786.`
  );
}
