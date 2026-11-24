"use client";

// The driver's "Delivered ✓" button on /d/<token>. One tap tells
// the website the food arrived: the order's delivery status becomes
// 'delivered' and the customer gets the delivered text (the shared
// applyDeliveryStatus path fires it exactly once).

import { useState } from "react";

export default function DriverDeliveredButton({ token }: { token: string }) {
  const [state, setState] = useState<"idle" | "busy" | "done" | "error">("idle");

  if (state === "done") {
    return (
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
        ✓ Delivered — thank you!
      </div>
    );
  }

  return (
    <button
      type="button"
      disabled={state === "busy"}
      onClick={async () => {
        setState("busy");
        try {
          const res = await fetch("/api/driver-delivered", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ token }),
          });
          if (!res.ok) throw new Error("request failed");
          setState("done");
        } catch {
          setState("error");
        }
      }}
      style={{
        width: "100%",
        background: "#2e7d32",
        color: "#fff",
        border: "none",
        borderRadius: 12,
        padding: "1rem",
        fontSize: "1.25rem",
        fontWeight: 700,
        cursor: "pointer",
      }}
    >
      {state === "busy"
        ? "Saving…"
        : state === "error"
          ? "Something went wrong — tap to try again"
          : "Delivered ✓"}
    </button>
  );
}
