"use client";

// House Delivery live tracking — the driver's side. "Start
// delivery" begins a geolocation watch; the phone posts its GPS
// to /api/driver-location about every 10 seconds while this page
// stays open. The first accepted post flips the order to
// 'out_for_delivery' on the server (the customer gets the
// on-its-way text and sees the live map). When the API reports
// the order delivered, sharing stops itself. Nothing is shared
// before the driver taps Start, and closing the page ends the
// watch with it.

import { useEffect, useRef, useState } from "react";

export default function DriverLocationShare({
  token,
  alreadyOut,
}: {
  token: string;
  alreadyOut: boolean;
}) {
  const [state, setState] = useState<"idle" | "sharing" | "denied" | "unsupported">(
    "idle"
  );
  const watchRef = useRef<number | null>(null);
  const lastSentRef = useRef(0);
  const stateRef = useRef(state);
  stateRef.current = state;

  const stopWatch = () => {
    if (watchRef.current !== null && "geolocation" in navigator) {
      navigator.geolocation.clearWatch(watchRef.current);
    }
    watchRef.current = null;
  };

  const send = async (lat: number, lng: number) => {
    try {
      const res = await fetch("/api/driver-location", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, lat, lng }),
      });
      const data = (await res.json().catch(() => null)) as {
        status?: string;
      } | null;
      if (data?.status === "delivered") {
        stopWatch();
        setState("idle");
      }
    } catch {
      /* transient — the next fix retries */
    }
  };

  const start = () => {
    if (!("geolocation" in navigator)) {
      setState("unsupported");
      return;
    }
    stopWatch();
    setState("sharing");
    watchRef.current = navigator.geolocation.watchPosition(
      (pos) => {
        const now = Date.now();
        if (now - lastSentRef.current < 10000 && lastSentRef.current !== 0) {
          return;
        }
        lastSentRef.current = now;
        void send(pos.coords.latitude, pos.coords.longitude);
      },
      (err) => {
        if (err.code === err.PERMISSION_DENIED) {
          stopWatch();
          setState("denied");
        }
      },
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 }
    );
  };

  // Mid-delivery page reload: resume sharing on its own — the
  // permission was already granted and the run is still going.
  useEffect(() => {
    if (alreadyOut) start();
    return () => stopWatch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (state === "sharing") {
    return (
      <div
        style={{
          background: "#e7f6ec",
          border: "2px solid #2e7d32",
          color: "#1b5e20",
          borderRadius: 12,
          padding: "1rem",
          textAlign: "center",
        }}
      >
        <div style={{ fontSize: "1.15rem", fontWeight: 700 }}>
          📍 Sharing your location live
        </div>
        <div style={{ fontSize: "0.95rem", marginTop: "0.25rem" }}>
          Keep this page open while you drive — the customer can see you on
          the map.
        </div>
        <button
          type="button"
          onClick={() => {
            stopWatch();
            setState("idle");
          }}
          style={{
            marginTop: "0.6rem",
            background: "#fff",
            color: "#1b5e20",
            border: "1px solid #2e7d32",
            borderRadius: 8,
            padding: "0.45rem 0.9rem",
            fontWeight: 700,
            cursor: "pointer",
          }}
        >
          Stop sharing
        </button>
      </div>
    );
  }

  return (
    <div>
      <button
        type="button"
        onClick={start}
        style={{
          width: "100%",
          background: "#0f2b4c",
          color: "#fff",
          border: "none",
          borderRadius: 12,
          padding: "1rem",
          fontSize: "1.15rem",
          fontWeight: 700,
          cursor: "pointer",
        }}
      >
        ▶ Start delivery — share my location
      </button>
      {state === "denied" && (
        <p style={{ color: "#b00020", marginTop: "0.5rem" }}>
          Location is blocked. Allow location for this site in your browser
          settings, then tap Start again.
        </p>
      )}
      {state === "unsupported" && (
        <p style={{ color: "#b00020", marginTop: "0.5rem" }}>
          This browser cannot share location. The Navigate button above
          still works.
        </p>
      )}
    </div>
  );
}
