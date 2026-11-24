"use client";

// The curbside "I'm here" button — shared by the storefront's
// post-order confirmation banner and the /track page. One tap tells
// the kitchen the customer is outside; the server records the FIRST
// tap only (see /api/curbside-here), so the button settles into its
// "✓ We know you're here" state and never re-alerts.

import { useState } from "react";

export default function CurbsideHere({
  orderId,
  phone,
  alreadyHere,
  carDescription,
}: {
  orderId: number;
  phone: string;
  /** True when the order already carries a customer_here_at time. */
  alreadyHere: boolean;
  carDescription?: string | null;
}) {
  const [here, setHere] = useState(alreadyHere);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");

  async function tap() {
    if (here || busy) return;
    setBusy(true);
    setNote("");
    try {
      const res = await fetch("/api/curbside-here", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ order_id: orderId, phone }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        message?: string;
      };
      if (data.ok) {
        setHere(true);
      } else {
        setNote(
          data.message ||
            "We couldn't check you in — please come to the counter and give your order number."
        );
      }
    } catch {
      setNote(
        "We couldn't check you in — please come to the counter and give your order number."
      );
    } finally {
      setBusy(false);
    }
  }

  if (here) {
    return (
      <div className="here-box done">
        <strong>✓ We know you&apos;re here</strong>
        <span>Stay in your car — we&apos;ll bring your order out to you. 🚗</span>
      </div>
    );
  }
  return (
    <div className="here-box">
      <strong>🚗 Curbside pickup{carDescription ? ` — ${carDescription}` : ""}</strong>
      <span>Parked outside? Tap the button and we&apos;ll bring your order to your car.</span>
      <button type="button" className="here-btn" onClick={tap} disabled={busy}>
        {busy ? "Checking you in…" : "📍 I'm here"}
      </button>
      {note && <div className="fee-msg err">{note}</div>}
    </div>
  );
}
