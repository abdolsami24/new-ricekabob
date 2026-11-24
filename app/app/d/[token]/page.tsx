// /d/<token> — the House Delivery driver page.
//
// The driver scans the QR code printed on the paper ticket (or
// shown on the kitchen screen) and lands here — no login, the
// unguessable token in the link is the only credential, and the
// page shows ONLY this one order. One tap on Navigate opens Google
// Maps with the customer's address already filled in; the phone
// number is tap-to-call; the items and total are listed; and the
// "Delivered ✓" button at the bottom marks the delivery done
// (which also texts the customer).

import type { Metadata } from "next";
import { getOrderByDriverToken } from "@/lib/delivery";
import { formatCents } from "@/lib/menu";
import DriverDeliveredButton from "@/components/DriverDeliveredButton";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Delivery — Madinah Market",
  robots: { index: false, follow: false },
};

const wrap: React.CSSProperties = {
  maxWidth: 480,
  margin: "0 auto",
  padding: "1rem",
  display: "flex",
  flexDirection: "column",
  gap: "1rem",
  fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
};

export default async function DriverPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const order = await getOrderByDriverToken(token);

  if (!order) {
    return (
      <main style={wrap}>
        <h1 style={{ fontSize: "1.4rem" }}>Link not valid</h1>
        <p>
          This delivery link is not recognized. Please ask the restaurant for
          help, or call{" "}
          <a href="tel:+17207630786">720-763-0786</a>.
        </p>
      </main>
    );
  }

  const address = order.delivery_address ?? "";
  const mapsUrl = `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(address)}`;
  const delivered = order.delivery_status === "delivered";
  const phoneDigits = (order.customer_phone ?? "").replace(/[^\d+]/g, "");

  return (
    <main style={wrap}>
      <div>
        <div style={{ fontSize: "0.95rem", color: "#666" }}>
          🏠 HOUSE DELIVERY — Order #{order.id}
        </div>
        <div style={{ fontSize: "1.6rem", fontWeight: 800 }}>
          {order.customer_name ?? "Customer"}
        </div>
      </div>

      <a
        href={mapsUrl}
        style={{
          display: "block",
          background: "#0f2b4c",
          color: "#fff",
          textDecoration: "none",
          borderRadius: 12,
          padding: "1.1rem",
          fontSize: "1.35rem",
          fontWeight: 800,
          textAlign: "center",
        }}
      >
        📍 Navigate — Google Maps
      </a>

      <div
        style={{
          border: "1px solid #ddd",
          borderRadius: 12,
          padding: "1rem",
        }}
      >
        <div style={{ fontSize: "0.85rem", color: "#666" }}>ADDRESS</div>
        <div style={{ fontSize: "1.3rem", fontWeight: 700, lineHeight: 1.35 }}>
          {address}
        </div>
        {phoneDigits && (
          <>
            <div style={{ fontSize: "0.85rem", color: "#666", marginTop: "0.9rem" }}>
              PHONE
            </div>
            <a
              href={`tel:${phoneDigits}`}
              style={{ fontSize: "1.3rem", fontWeight: 700, color: "#0f2b4c" }}
            >
              📞 {order.customer_phone}
            </a>
          </>
        )}
      </div>

      <div
        style={{
          border: "1px solid #ddd",
          borderRadius: 12,
          padding: "1rem",
        }}
      >
        <div style={{ fontSize: "0.85rem", color: "#666" }}>ORDER</div>
        <ul style={{ listStyle: "none", margin: "0.4rem 0 0", padding: 0 }}>
          {(order.items_json ?? []).map((line, i) => (
            <li
              key={i}
              style={{
                display: "flex",
                justifyContent: "space-between",
                padding: "0.25rem 0",
                fontSize: "1.05rem",
              }}
            >
              <span>
                {line.qty} × {line.name}
              </span>
              <span>{formatCents(line.line_total_cents)}</span>
            </li>
          ))}
        </ul>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            borderTop: "1px solid #eee",
            marginTop: "0.5rem",
            paddingTop: "0.5rem",
            fontWeight: 800,
            fontSize: "1.1rem",
          }}
        >
          <span>Total {order.payment_status === "test_paid" ? "(test order)" : "(paid online)"}</span>
          <span>{formatCents(order.total_cents)}</span>
        </div>
        {order.note?.trim() && (
          <div style={{ marginTop: "0.5rem" }}>📝 {order.note.trim()}</div>
        )}
      </div>

      {delivered ? (
        <div
          style={{
            background: "#e7f6ec",
            border: "2px solid #2e7d32",
            color: "#1b5e20",
            borderRadius: 12,
            padding: "1rem",
            fontSize: "1.25rem",
            fontWeight: 700,
            textAlign: "center",
          }}
        >
          ✓ Delivered
        </div>
      ) : (
        <DriverDeliveredButton token={token} />
      )}
    </main>
  );
}
