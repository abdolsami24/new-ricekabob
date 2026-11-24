"use client";

// Kitchen Display System (KDS).
// - Supabase Auth login gate (email + password).
// - Live feed: polls /api/kitchen/orders every 5 seconds with the staff
//   access token; a Supabase Realtime subscription triggers instant
//   refetches as a bonus (polling is the guaranteed path).
// - New paid order => the card simply appears on the board and ONE
//   single "ding" sound plays, once. No voice, no repeating alarm,
//   no banner to tap (owner's request, 2026-11-18).
// - ONE-TAP FLOW (owner's design, 2026-11-18): paid orders arrive
//   already "Accepted" (auto-accept at payment — there are NO status
//   step buttons). The chef taps the TOP of the card when the food is
//   ready: one tap completes the order, it leaves the board, the
//   pickup customer gets the ready SMS and the TV board shows READY.
// - Print lives in the card footer, outside the tap area. There is
//   NO Cancel in the kitchen (owner's rule, 2026-11-18): once an
//   order is Accepted it cannot be cancelled here — cancelling stays
//   possible only for the owner in the admin panel.
// - NO Admin link and NO Log out button on this page (owner's rule,
//   2026-11-18): the kitchen screen is only for seeing orders and
//   the one ready tap — nothing else can be done from here.
// - 80mm ticket printing, auto-print toggle.

import { useCallback, useEffect, useRef, useState } from "react";
import { getBrowserClient } from "@/lib/supabase/client";
import { formatCents } from "@/lib/menu";
import { formatDenverTime } from "@/lib/hours";
import QrCode from "@/components/QrCode";
import type { Session } from "@supabase/supabase-js";

interface KitchenOrder {
  id: number;
  customer_name: string | null;
  customer_phone: string | null;
  items_json: {
    name: string;
    qty: number;
    line_total_cents: number;
    options?: { group: string; name: string; price_delta_cents: number }[];
    instructions?: string;
  }[];
  subtotal_cents: number;
  discount_cents: number;
  service_fee_cents?: number;
  tax_cents: number;
  delivery_fee_cents: number;
  delivery_markup_cents?: number;
  free_delivery?: boolean;
  tip_cents: number;
  total_cents: number;
  fulfillment: string;
  delivery_address: string | null;
  /** Curbside (absent until supabase/curbside-schema.sql runs). */
  car_description?: string | null;
  customer_here_at?: string | null;
  /** Order-level checkout note (absent until supabase/order-note-schema.sql runs). */
  note?: string | null;
  scheduled_for: string | null;
  payment_status: string;
  kitchen_status: string;
  shipday_order_id: string | null;
  shipday_status: string | null;
  /** House Delivery (absent until the columns exist on the row). */
  delivery_provider?: string | null;
  driver_token?: string | null;
  delivery_status?: string | null;
  created_at: string;
}

function isPaid(o: KitchenOrder): boolean {
  return o.payment_status === "paid" || o.payment_status === "test_paid";
}

function isActive(o: KitchenOrder): boolean {
  return o.kitchen_status !== "completed" && o.kitchen_status !== "cancelled";
}

// One single "ding" — played exactly once when a new order arrives.
function chime() {
  try {
    const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new Ctx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = 880;
    osc.connect(gain);
    gain.connect(ctx.destination);
    const start = ctx.currentTime;
    osc.start(start);
    gain.gain.setValueAtTime(0.3, start);
    gain.gain.exponentialRampToValueAtTime(0.001, start + 0.9);
    osc.stop(start + 0.95);
  } catch {
    /* audio is best-effort */
  }
}

function printTicket(order: KitchenOrder) {
  const win = window.open("", "_blank", "width=400,height=600");
  if (!win) return;
  // One merged delivery line (DoorDash fee + extra markup), FREE when
  // the Free Delivery promotion applied — same lines as the customer.
  const deliveryCharge = order.delivery_fee_cents + (order.delivery_markup_cents ?? 0);
  const deliveryRow =
    order.fulfillment !== "delivery"
      ? ""
      : order.free_delivery
        ? `<div class="row"><span>Delivery fee</span><span>FREE</span></div>`
        : deliveryCharge > 0
          ? `<div class="row"><span>Delivery fee</span><span>${formatCents(deliveryCharge)}</span></div>`
          : "";
  const items = (order.items_json ?? [])
    .map((l) => {
      const opts = (l.options ?? [])
        .map((o) => `<div style="margin-left:4mm">+ ${o.name}</div>`)
        .join("");
      const note = l.instructions
        ? `<div style="margin-left:4mm"><strong>NOTE:</strong> ${l.instructions}</div>`
        : "";
      return `<div>${l.qty} x ${l.name} — ${formatCents(l.line_total_cents)}</div>${opts}${note}`;
    })
    .join("");
  win.document.write(`<!doctype html><html><head><title>Order #${order.id}</title>
    <style>body{font-family:monospace;width:72mm;margin:0 auto;padding:4mm}h1{text-align:center;font-size:28px;margin:2mm 0}
    .c{text-align:center}.row{display:flex;justify-content:space-between}.grand{font-size:18px;font-weight:bold}</style>
    </head><body>
    <div class="c">MADINAH BAKERY & KABOB</div>
    <h1>#${order.id}</h1>
    <div class="c">${order.fulfillment.toUpperCase()} · ${new Date(order.created_at).toLocaleString()}</div>
    ${order.scheduled_for ? `<div class="c" style="font-size:20px;font-weight:bold">⏰ PICKUP AT ${formatDenverTime(order.scheduled_for)}</div>` : ""}
    <hr/>
    <div>${order.customer_name ?? ""} · ${order.customer_phone ?? ""}</div>
    ${order.fulfillment === "delivery" ? `<div><strong>DELIVERY:</strong> ${order.delivery_address ?? ""}</div>` : ""}
    ${order.fulfillment === "curbside" ? `<div><strong>CAR:</strong> ${order.car_description ?? ""}</div>` : ""}
    <hr/>${items}<hr/>
    <div class="row"><span>Subtotal</span><span>${formatCents(order.subtotal_cents)}</span></div>
    ${order.discount_cents > 0 ? `<div class="row"><span>Loyalty discount</span><span>-${formatCents(order.discount_cents)}</span></div>` : ""}
    ${(order.service_fee_cents ?? 0) > 0 ? `<div class="row"><span>Service fee</span><span>${formatCents(order.service_fee_cents ?? 0)}</span></div>` : ""}
    <div class="row"><span>Tax</span><span>${formatCents(order.tax_cents)}</span></div>
    ${deliveryRow}
    ${order.tip_cents > 0 ? `<div class="row"><span>Tip</span><span>${formatCents(order.tip_cents)}</span></div>` : ""}
    <div class="row grand"><span>TOTAL</span><span>${formatCents(order.total_cents)}</span></div>
    <script>window.onload=()=>{window.print();}</script>
    </body></html>`);
  win.document.close();
}

export default function KitchenBoard({ testMode }: { testMode: boolean }) {
  const [session, setSession] = useState<Session | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loginError, setLoginError] = useState("");
  const [orders, setOrders] = useState<KitchenOrder[]>([]);
  const [alertsOn, setAlertsOn] = useState(false);
  const [autoPrint, setAutoPrint] = useState(false);
  const seenPaidRef = useRef<Set<number>>(new Set());
  // Paid orders that arrived after the board loaded — they drive the
  // red "is-new" frame on the card until the order is completed.
  const freshRef = useRef<Set<number>>(new Set());
  const firstLoadRef = useRef(true);

  // ---- auth ---------------------------------------------------------------
  useEffect(() => {
    const supabase = getBrowserClient();
    if (!supabase) {
      setAuthReady(true);
      return;
    }
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setAuthReady(true);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    setAlertsOn(localStorage.getItem("madinah_alerts_on") === "1");
    setAutoPrint(localStorage.getItem("madinah_autoprint") === "1");
  }, []);

  async function login(e: React.FormEvent) {
    e.preventDefault();
    setLoginError("");
    const supabase = getBrowserClient();
    if (!supabase) return setLoginError("Supabase is not configured on this site yet.");
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) setLoginError("Login failed — check the email and password.");
  }

  // ---- order feed -----------------------------------------------------------
  const fetchOrders = useCallback(async () => {
    if (!session) return;
    try {
      const res = await fetch("/api/kitchen/orders", {
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      if (!res.ok) return;
      const data = (await res.json()) as { orders: KitchenOrder[] };
      const list = data.orders ?? [];

      // New-arrival handling for newly seen PAID orders: auto-print
      // (if enabled) + ONE single ding. The order card itself simply
      // appears in the grid below — nothing to tap, nothing to stop.
      const fresh = list.filter((o) => isPaid(o) && !seenPaidRef.current.has(o.id));
      for (const o of list) {
        if (isPaid(o)) seenPaidRef.current.add(o.id);
      }
      if (!firstLoadRef.current && fresh.length > 0) {
        if (autoPrint) fresh.forEach((o) => printTicket(o));
        for (const o of fresh) {
          if (isActive(o)) freshRef.current.add(o.id);
        }
        if (alertsOn && fresh.some((o) => isActive(o))) chime();
      }
      firstLoadRef.current = false;
      setOrders(list);
    } catch {
      /* next poll retries */
    }
  }, [session, alertsOn, autoPrint]);

  useEffect(() => {
    if (!session) return;
    fetchOrders();
    const poll = setInterval(fetchOrders, 5000);
    const supabase = getBrowserClient();
    let channel: ReturnType<NonNullable<typeof supabase>["channel"]> | null = null;
    if (supabase) {
      channel = supabase
        .channel("kitchen-orders")
        .on("postgres_changes", { event: "*", schema: "public", table: "orders" }, () => {
          fetchOrders();
        })
        .subscribe();
    }
    return () => {
      clearInterval(poll);
      if (supabase && channel) supabase.removeChannel(channel);
    };
  }, [session, fetchOrders]);

  async function setStatus(order: KitchenOrder, status: string) {
    if (!session) return;
    await fetch("/api/kitchen/status", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${session.access_token}`,
      },
      body: JSON.stringify({ order_id: order.id, status }),
    }).catch(() => undefined);
    fetchOrders();
  }

  // THE one tap: the chef taps the top of the card when the food is
  // ready. The order is completed in a single action (the server fires
  // the pickup-ready SMS and the TV board keeps it as READY for a
  // while) and leaves the main board immediately — the local state is
  // updated optimistically so the card moves to "Completed today" on
  // the tap itself, then the refetch confirms it.
  async function completeOrder(order: KitchenOrder) {
    freshRef.current.delete(order.id);
    setOrders((prev) =>
      prev.map((o) => (o.id === order.id ? { ...o, kitchen_status: "completed" } : o))
    );
    await setStatus(order, "completed");
  }

  function turnOnAlerts() {
    setAlertsOn(true);
    localStorage.setItem("madinah_alerts_on", "1");
    // Playing the ding inside this tap unlocks audio for later
    // arrivals (browsers block sound before the first interaction).
    chime();
  }

  // ---- render ---------------------------------------------------------------
  if (!authReady) {
    return (
      <div className="kitchen-body">
        <div className="kitchen-wrap">Loading…</div>
      </div>
    );
  }

  if (!session) {
    return (
      <div className="kitchen-body">
        <form className="k-login" onSubmit={login}>
          <h1 style={{ color: "var(--gold-soft)", marginTop: 0 }}>🍳 Kitchen Login</h1>
          <p>Madinah Market staff only.</p>
          <label>
            Email
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
          </label>
          <label>
            Password
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </label>
          {loginError && <p style={{ color: "#fca5a5" }}>{loginError}</p>}
          <button type="submit">Log in</button>
        </form>
      </div>
    );
  }

  // Active board: completed orders LEAVE the main list as soon as they are
  // completed (staff request) and move to the "Completed today" section
  // below; cancelled orders stay hidden entirely.
  const visible = orders.filter(
    (o) => o.kitchen_status !== "cancelled" && o.kitchen_status !== "completed"
  );
  const doneToday = orders.filter((o) => o.kitchen_status === "completed");

  return (
    <div className="kitchen-body">
      <div className="kitchen-wrap">
        <div className="kitchen-head">
          <h1>🍳 Kitchen — Madinah Market {testMode && <span style={{ color: "#fca5a5" }}>(TEST MODE)</span>}</h1>
          <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
            {!alertsOn && (
              <button type="button" className="k-btn warn" onClick={turnOnAlerts}>
                🔊 Turn on order alerts
              </button>
            )}
            <label className="k-btn" style={{ display: "inline-flex", gap: "0.4rem", alignItems: "center" }}>
              <input
                type="checkbox"
                checked={autoPrint}
                onChange={(e) => {
                  setAutoPrint(e.target.checked);
                  localStorage.setItem("madinah_autoprint", e.target.checked ? "1" : "0");
                }}
              />
              Auto-print new orders
            </label>
          </div>
        </div>

        {visible.length === 0 && <p style={{ marginTop: "1.5rem" }}>No active orders.</p>}

        <div className="k-grid">
          {visible.map((o) => {
            // Curbside: the customer tapped "I'm here" and is waiting
            // outside — the card lights up until the order completes.
            const customerHere =
              o.fulfillment === "curbside" && Boolean(o.customer_here_at);
            return (
              <article
                className={`k-card${freshRef.current.has(o.id) ? " is-new" : ""}${
                  customerHere ? " customer-here" : ""
                }`}
                key={o.id}
              >
                {/* ONE TAP: the whole header is the ready button. Print
                    lives in the footer, outside this area. */}
                <div
                  className="k-taphead"
                  role="button"
                  tabIndex={0}
                  aria-label={`Order #${o.id} — tap when the food is ready`}
                  onClick={() => completeOrder(o)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      completeOrder(o);
                    }
                  }}
                >
                  <h2>
                    #{o.id}{" "}
                    <span
                      className={`k-badge ${
                        o.fulfillment === "delivery"
                          ? "delivery"
                          : o.fulfillment === "curbside"
                            ? "curbside"
                            : "pickup"
                      }`}
                    >
                      {o.fulfillment === "delivery"
                        ? o.delivery_provider === "house"
                          ? "🏠 HOUSE DELIVERY"
                          : "🛵 DELIVERY"
                        : o.fulfillment === "curbside"
                          ? "🚗 CURBSIDE"
                          : "🏃 PICKUP"}
                    </span>
                    <span className={`k-badge ${o.payment_status === "unpaid" ? "unpaid" : "paid"}`}>
                      {o.payment_status === "test_paid"
                        ? "TEST PAID"
                        : o.payment_status.toUpperCase()}
                    </span>
                  </h2>
                  <div>
                    {o.customer_name ?? ""} · {o.customer_phone ?? ""}
                  </div>
                  {o.fulfillment === "curbside" && o.car_description && (
                    <div style={{ fontWeight: 700 }}>🚗 {o.car_description}</div>
                  )}
                  {customerHere && (
                    <div className="k-here-banner">
                      🚗 CUSTOMER IS HERE
                      {o.customer_here_at
                        ? ` — since ${new Date(o.customer_here_at).toLocaleTimeString()}`
                        : ""}
                    </div>
                  )}
                  {o.note?.trim() && (
                    <div style={{ fontWeight: 700 }}>📝 NOTE: {o.note}</div>
                  )}
                  <div style={{ color: "#cbbfa8", fontSize: "0.95rem" }}>
                    {new Date(o.created_at).toLocaleTimeString()} ·{" "}
                    {isPaid(o) ? (
                      <span className="k-status-accepted">✔ Accepted</span>
                    ) : (
                      <span>⏳ Awaiting payment</span>
                    )}
                  </div>
                  {o.scheduled_for && (
                    <div
                      style={{
                        marginTop: "0.3rem",
                        background: "#f59e0b",
                        color: "#1a1207",
                        fontWeight: 800,
                        borderRadius: 8,
                        padding: "0.25rem 0.6rem",
                        display: "inline-block",
                      }}
                    >
                      ⏰ PICKUP AT {formatDenverTime(o.scheduled_for)}
                    </div>
                  )}
                  <div className="k-hint">👆 Tap here when the food is ready</div>
                </div>
                {o.fulfillment === "delivery" && o.delivery_provider === "house" && (
                  <div style={{ marginTop: "0.3rem" }}>
                    📍 {o.delivery_address ?? ""}
                    <div style={{ marginTop: "0.4rem" }}>
                      🏠 <strong>House delivery</strong> — driver scans the QR on
                      the printed ticket
                      {o.delivery_status === "delivered" ? " · ✓ DELIVERED" : ""}
                    </div>
                    {o.driver_token && (
                      <div style={{ marginTop: "0.4rem" }}>
                        <QrCode
                          text={`${typeof window !== "undefined" ? window.location.origin : ""}/d/${o.driver_token}`}
                          size={110}
                        />
                      </div>
                    )}
                  </div>
                )}
                {o.fulfillment === "delivery" && o.delivery_provider !== "house" && (
                  <div style={{ marginTop: "0.3rem" }}>
                    📍 {o.delivery_address ?? ""}
                    <br />
                    Shipday:{" "}
                    {o.shipday_order_id
                      ? `sent #${o.shipday_order_id} · ${o.shipday_status ?? ""}`
                      : (o.shipday_status ?? "not sent")}
                  </div>
                )}
                <ul className="k-items">
                  {(o.items_json ?? []).map((l, i) => (
                    <li key={i}>
                      {l.qty} × {l.name} — {formatCents(l.line_total_cents)}
                      {(l.options ?? []).map((opt) => (
                        <div className="k-opt" key={`${opt.group}::${opt.name}`}>
                          + {opt.name}
                          {opt.price_delta_cents > 0
                            ? ` (${formatCents(opt.price_delta_cents)})`
                            : ""}
                        </div>
                      ))}
                      {l.instructions && (
                        <div className="k-opt k-note">📝 {l.instructions}</div>
                      )}
                    </li>
                  ))}
                </ul>
                <div className="k-money">
                  <div className="row">
                    <span>Subtotal</span>
                    <span>{formatCents(o.subtotal_cents)}</span>
                  </div>
                  {o.discount_cents > 0 && (
                    <div className="row">
                      <span>⭐ Loyalty discount</span>
                      <span>−{formatCents(o.discount_cents)}</span>
                    </div>
                  )}
                  {(o.service_fee_cents ?? 0) > 0 && (
                    <div className="row">
                      <span>Service fee</span>
                      <span>{formatCents(o.service_fee_cents ?? 0)}</span>
                    </div>
                  )}
                  <div className="row">
                    <span>Tax</span>
                    <span>{formatCents(o.tax_cents)}</span>
                  </div>
                  {o.fulfillment === "delivery" &&
                    (o.free_delivery ||
                      o.delivery_fee_cents + (o.delivery_markup_cents ?? 0) > 0) && (
                      <div className="row">
                        <span>Delivery fee</span>
                        <span>
                          {o.free_delivery
                            ? "FREE"
                            : formatCents(o.delivery_fee_cents + (o.delivery_markup_cents ?? 0))}
                        </span>
                      </div>
                    )}
                  {o.tip_cents > 0 && (
                    <div className="row">
                      <span>Tip</span>
                      <span>{formatCents(o.tip_cents)}</span>
                    </div>
                  )}
                  <div className="row grand">
                    <span>TOTAL</span>
                    <span>{formatCents(o.total_cents)}</span>
                  </div>
                </div>
                <div className="k-actions">
                  <button type="button" className="secondary" onClick={() => printTicket(o)}>
                    🖨 Print ticket
                  </button>
                </div>
              </article>
            );
          })}
        </div>

        {doneToday.length > 0 && (
          <details style={{ marginTop: "2rem" }}>
            <summary style={{ cursor: "pointer", color: "#cbbfa8", fontWeight: 700 }}>
              ✔ Completed today ({doneToday.length}) — tap to view
            </summary>
            <div style={{ marginTop: "0.6rem", color: "#cbbfa8" }}>
              {doneToday.map((o) => (
                <div
                  key={o.id}
                  style={{ padding: "0.35rem 0", borderBottom: "1px dashed #444" }}
                >
                  #{o.id} · {o.customer_name ?? ""} ·{" "}
                  {o.fulfillment === "delivery"
                    ? "🛵 Delivery"
                    : o.fulfillment === "curbside"
                      ? "🚗 Curbside"
                      : "🏃 Pickup"} ·{" "}
                  {formatCents(o.total_cents)} ·{" "}
                  {new Date(o.created_at).toLocaleTimeString()}
                </div>
              ))}
            </div>
          </details>
        )}
      </div>
    </div>
  );
}
