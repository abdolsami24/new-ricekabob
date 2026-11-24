"use client";

// Customer order tracking. The customer enters the order number and the
// phone used at checkout; /api/track-order only returns the order when
// the phone's last 10 digits match. The page refreshes every 20 seconds
// and draws a friendly timeline for pickup or delivery.
//
// One-tap tracking (usability item 5): arriving from the storefront's
// confirmation banner (/track?order=N) in the same tab, the page finds
// the just-placed order's phone in the storefront's sessionStorage
// snapshot (lib/lastOrder.ts) and runs the lookup immediately.

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { formatCents } from "@/lib/menu";
import CurbsideHere from "@/components/CurbsideHere";
import {
  deliveryStatusLabel,
  deliveryStepIndex,
  deliveryIsFailed,
} from "@/lib/deliveryStatus";
import { LAST_ORDER_KEY, resolveTrackAutoLookup } from "@/lib/lastOrder";

interface TrackedOrder {
  id: number;
  items: {
    name: string;
    qty: number;
    line_total_cents: number;
    options?: { group: string; name: string; price_delta_cents: number }[];
    instructions?: string;
  }[];
  subtotal_cents: number;
  service_fee_cents?: number;
  tax_cents: number;
  delivery_fee_cents: number;
  delivery_markup_cents?: number;
  free_delivery?: boolean;
  tip_cents: number;
  total_cents: number;
  fulfillment: string;
  delivery_address: string | null;
  /** Curbside only: the car text + the "I'm here" arrival time. */
  car_description?: string | null;
  customer_here_at?: string | null;
  payment_status: string;
  kitchen_status: string;
  shipday_status: string | null;
  delivery_provider?: string | null;
  delivery_status?: string | null;
  /** Live tracking: DoorDash's live-map URL + house driver GPS. */
  delivery_tracking_url?: string | null;
  driver_lat?: number | null;
  driver_lng?: number | null;
  driver_loc_at?: string | null;
  created_at: string;
}

function stepIndex(order: TrackedOrder): number {
  // Index of the last completed step on the timeline. One-tap kitchen
  // flow (2026-11-18): the customer's steps are Order received ->
  // Accepted (paid, auto-accepted — legacy 'preparing' rows land here
  // too) -> Ready (the chef's one tap; stored as 'completed') ->
  // Picked up / Delivered. There is no separate "Preparing" step.
  const ks = order.kitchen_status;
  if (order.fulfillment === "delivery") {
    // Stage 3: the DoorDash delivery status drives the later steps
    // when this order has one; older orders fall back to Shipday text.
    const dd = deliveryStepIndex(order.delivery_status);
    if (dd !== null) return dd;
    if (ks === "completed") return 3;
    const ship = (order.shipday_status ?? "").toLowerCase();
    if (ship.includes("deliver")) return 3;
    if (ks === "ready" || ship.includes("picked") || ship.includes("out_for") || ship.includes("transit")) return 2;
    if (ks === "preparing" || ks === "accepted") return 1;
    return 0;
  }
  switch (ks) {
    case "completed":
      return 3;
    case "ready":
      return 2;
    case "preparing":
    case "accepted":
      return 1;
    default:
      return 0;
  }
}

export default function TrackPage() {
  const [orderId, setOrderId] = useState("");
  const [phone, setPhone] = useState("");
  const [order, setOrder] = useState<TrackedOrder | null>(null);
  const [message, setMessage] = useState("");
  const [searching, setSearching] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const autoRanRef = useRef(false);

  const lookup = useCallback(
    async (id: string, ph: string, silent = false) => {
      if (!silent) setSearching(true);
      try {
        const res = await fetch("/api/track-order", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ order_id: Number(id), phone: ph }),
        });
        const data = await res.json();
        if (data.found) {
          setOrder(data.order as TrackedOrder);
          setMessage("");
        } else if (!silent) {
          setOrder(null);
          setMessage(
            "We couldn't find that order. Check the order number and use the same phone number you ordered with."
          );
        }
      } catch {
        if (!silent) setMessage("Something went wrong — please try again.");
      } finally {
        if (!silent) setSearching(false);
      }
    },
    []
  );

  // Prefill from ?order= (the storefront success banner links here).
  // When the snapshot from that same checkout is still in this tab,
  // prefill the phone too and run the lookup once — no typing, no tap.
  // Anything missing → the plain form, exactly as before. A failed
  // auto-lookup leaves the form visible and prefilled with the usual
  // "couldn't find that order" message (handled inside lookup).
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const o = params.get("order");
    if (o) setOrderId(o);
    if (autoRanRef.current) return;
    let raw: string | null = null;
    try {
      raw = sessionStorage.getItem(LAST_ORDER_KEY);
    } catch {
      /* storage unavailable — plain form */
    }
    const auto = resolveTrackAutoLookup(o, raw);
    if (auto) {
      autoRanRef.current = true;
      setPhone(auto.phone);
      lookup(auto.orderId, auto.phone);
    }
  }, [lookup]);

  // Auto-refresh every 20 seconds once an order is shown.
  useEffect(() => {
    if (pollRef.current) clearInterval(pollRef.current);
    if (order) {
      pollRef.current = setInterval(() => lookup(orderId, phone, true), 20000);
    }
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [order, orderId, phone, lookup]);

  const steps =
    order?.fulfillment === "delivery"
      ? ["Order received", "Accepted", "Driver on the way", "Delivered"]
      : order?.fulfillment === "curbside"
        ? ["Order received", "Accepted", "Ready", "Brought to your car"]
        : ["Order received", "Accepted", "Ready", "Picked up"];
  const current = order ? stepIndex(order) : -1;

  return (
    <>
      <header className="site-header standalone">
        <h1>
          Madinah <span className="gold">Market</span>
        </h1>
        <p>Track your order</p>
      </header>
      <main className="simple-page">
        <h1>📦 Where is my order?</h1>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            lookup(orderId, phone);
          }}
        >
          <div className="field">
            <label htmlFor="t-order">Order number</label>
            <input
              id="t-order"
              inputMode="numeric"
              value={orderId}
              onChange={(e) => setOrderId(e.target.value)}
              placeholder="e.g. 12"
              required
            />
          </div>
          <div className="field">
            <label htmlFor="t-phone">Phone number used at checkout</label>
            <input
              id="t-phone"
              inputMode="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="e.g. 720-763-0786"
              required
            />
          </div>
          <button type="submit" className="checkout-btn" disabled={searching}>
            {searching ? "Looking…" : "Track order"}
          </button>
        </form>

        {message && <p className="form-error">{message}</p>}

        {order && (
          <section className="panel">
            <h3>
              Order #{order.id} —{" "}
              {order.fulfillment === "delivery"
                ? "🛵 Delivery"
                : order.fulfillment === "curbside"
                  ? "🚗 Curbside"
                  : "🏃 Pickup"}
            </h3>
            {order.kitchen_status === "cancelled" ? (
              <p className="form-error">This order was cancelled. Please call us: 720-763-0786.</p>
            ) : (
              <>
                <ul className="timeline">
                  {steps.map((label, i) => (
                    <li key={label} className={i < current ? "done" : i === current ? "now" : ""}>
                      <span className="dot">{i < current ? "✓" : i + 1}</span>
                      <span>
                        {label}
                        {order.fulfillment === "delivery" && i === 2 && order.shipday_status && !order.delivery_status && (
                          <span style={{ display: "block", fontWeight: 400, fontSize: "0.9rem" }}>
                            {order.shipday_status}
                          </span>
                        )}
                      </span>
                    </li>
                  ))}
                </ul>
                {order.fulfillment === "delivery" && order.delivery_status && (
                  <p style={{ marginTop: "0.5rem" }}>
                    🚗 Delivery status:{" "}
                    <strong>{deliveryStatusLabel(order.delivery_status)}</strong>
                    {deliveryIsFailed(order.delivery_status) && (
                      <span className="form-error" style={{ display: "block" }}>
                        Something went wrong with this delivery — please call us: 720-763-0786.
                      </span>
                    )}
                  </p>
                )}
                {order.fulfillment === "delivery" &&
                  order.delivery_tracking_url &&
                  order.delivery_status !== "delivered" &&
                  !deliveryIsFailed(order.delivery_status) && (
                    <a
                      className="checkout-btn"
                      style={{
                        display: "block",
                        textAlign: "center",
                        marginTop: "0.75rem",
                        textDecoration: "none",
                      }}
                      href={order.delivery_tracking_url}
                      target="_blank"
                      rel="noreferrer"
                    >
                      🗺️ Track your driver live
                    </a>
                  )}
                {order.fulfillment === "delivery" &&
                  order.delivery_provider === "house" &&
                  order.driver_lat != null &&
                  order.driver_lng != null &&
                  order.delivery_status !== "delivered" && (
                    <div style={{ marginTop: "0.75rem" }}>
                      <iframe
                        key={order.driver_loc_at ?? "loc"}
                        title="Driver live location"
                        src={`https://www.openstreetmap.org/export/embed.html?bbox=${(order.driver_lng ?? 0) - 0.012}%2C${(order.driver_lat ?? 0) - 0.012}%2C${(order.driver_lng ?? 0) + 0.012}%2C${(order.driver_lat ?? 0) + 0.012}&layer=mapnik&marker=${order.driver_lat}%2C${order.driver_lng}`}
                        style={{
                          width: "100%",
                          height: 260,
                          border: "1px solid #ccc",
                          borderRadius: 12,
                        }}
                        loading="lazy"
                      />
                      <p style={{ color: "var(--muted)", fontSize: "0.9rem" }}>
                        🛵 Your driver&apos;s live location
                        {order.driver_loc_at
                          ? ` · updated ${Math.max(0, Math.round((Date.now() - new Date(order.driver_loc_at).getTime()) / 1000))}s ago`
                          : ""}{" "}
                        ·{" "}
                        <a
                          href={`https://www.google.com/maps?q=${order.driver_lat},${order.driver_lng}`}
                          target="_blank"
                          rel="noreferrer"
                        >
                          Open in Google Maps
                        </a>
                      </p>
                    </div>
                  )}
                {order.fulfillment === "curbside" &&
                  (order.payment_status === "paid" ||
                    order.payment_status === "test_paid") &&
                  order.kitchen_status !== "completed" && (
                    <CurbsideHere
                      key={order.customer_here_at ?? "not-here"}
                      orderId={order.id}
                      phone={phone}
                      alreadyHere={Boolean(order.customer_here_at)}
                      carDescription={order.car_description ?? null}
                    />
                  )}
              </>
            )}
            {(order.items ?? []).map((l, i) => (
              <div key={i}>
                <div className="cart-line">
                  <span>
                    {l.qty} × {l.name}
                  </span>
                  <span>{formatCents(l.line_total_cents)}</span>
                </div>
                {(l.options ?? []).map((o) => (
                  <div className="line-options" key={`${o.group}::${o.name}`}>
                    <span>• {o.name}</span>
                  </div>
                ))}
                {l.instructions && <div className="line-note">“{l.instructions}”</div>}
              </div>
            ))}
            <div className="breakdown">
              <div className="row">
                <span>Subtotal</span>
                <span>{formatCents(order.subtotal_cents)}</span>
              </div>
              {(order.service_fee_cents ?? 0) > 0 && (
                <div className="row">
                  <span>Service fee</span>
                  <span>{formatCents(order.service_fee_cents ?? 0)}</span>
                </div>
              )}
              <div className="row">
                <span>Tax</span>
                <span>{formatCents(order.tax_cents)}</span>
              </div>
              {order.fulfillment === "delivery" &&
                (order.free_delivery ||
                  order.delivery_fee_cents + (order.delivery_markup_cents ?? 0) > 0) && (
                  <div className="row">
                    <span>Delivery fee</span>
                    <span>
                      {order.free_delivery
                        ? "FREE 🎉"
                        : formatCents(
                            order.delivery_fee_cents + (order.delivery_markup_cents ?? 0)
                          )}
                    </span>
                  </div>
                )}
              {order.tip_cents > 0 && (
                <div className="row">
                  <span>Tip</span>
                  <span>{formatCents(order.tip_cents)}</span>
                </div>
              )}
              <div className="row grand">
                <span>TOTAL</span>
                <span>{formatCents(order.total_cents)}</span>
              </div>
            </div>
            {order.fulfillment === "delivery" && order.delivery_address && (
              <p style={{ color: "var(--muted)" }}>Delivering to: {order.delivery_address}</p>
            )}
            <p style={{ color: "var(--muted)", fontSize: "0.9rem" }}>
              This page refreshes automatically every 20 seconds.
            </p>
          </section>
        )}

        <p style={{ marginTop: "1.5rem" }}>
          <Link href="/menu">← Back to the menu</Link>
        </p>
      </main>
    </>
  );
}
