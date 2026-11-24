"use client";

// Renders a QR code as SVG from the pure encoder in lib/qrcode.ts
// (the same encoder whose module map rides inside print jobs, so
// the on-screen code and the printed code are identical).

import { useMemo } from "react";
import { encodeQr } from "@/lib/qrcode";

export default function QrCode({
  text,
  size = 120,
}: {
  text: string;
  size?: number;
}) {
  const qr = useMemo(() => encodeQr(text), [text]);
  if (!qr) return null;
  const quiet = 2;
  const total = qr.size + quiet * 2;
  const rects: React.ReactNode[] = [];
  for (let y = 0; y < qr.size; y++) {
    for (let x = 0; x < qr.size; x++) {
      if (qr.modules[y * qr.size + x]) {
        rects.push(
          <rect key={`${x}-${y}`} x={x + quiet} y={y + quiet} width={1.02} height={1.02} />
        );
      }
    }
  }
  return (
    <svg
      viewBox={`0 0 ${total} ${total}`}
      width={size}
      height={size}
      role="img"
      aria-label="QR code"
      style={{ background: "#fff", display: "block", borderRadius: 6 }}
    >
      <g fill="#000">{rects}</g>
    </svg>
  );
}
