// POST /api/driver-delivered  { token }
// The House Delivery driver's "Delivered ✓" tap. The token IS the
// credential (unguessable, one order only, issued at payment time);
// no login exists on the driver page by design. Applies the shared
// delivered path (status + customer SMS, exactly once).

import { NextResponse } from "next/server";
import { markHouseDelivered } from "@/lib/delivery";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  let body: Record<string, unknown> = {};
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    /* handled below */
  }
  const token = String(body.token ?? "");
  const ok = await markHouseDelivered(token);
  if (!ok) {
    return NextResponse.json({ error: "Unknown delivery link." }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
