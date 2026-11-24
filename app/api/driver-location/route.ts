// POST /api/driver-location  { token, lat, lng }
// House Delivery live tracking: the driver page posts the phone's
// GPS while a delivery runs. The unguessable driver token is the
// only credential (same trust model as /api/driver-delivered), and
// lib/delivery's updateDriverLocation only ever touches the one
// house order behind that token.

import { NextResponse } from "next/server";
import { updateDriverLocation } from "@/lib/delivery";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  let token = "";
  let lat = NaN;
  let lng = NaN;
  try {
    const body = (await req.json()) as {
      token?: string;
      lat?: number;
      lng?: number;
    };
    token = String(body.token ?? "");
    lat = Number(body.lat);
    lng = Number(body.lng);
  } catch {
    /* handled below */
  }
  if (
    !token ||
    !Number.isFinite(lat) ||
    !Number.isFinite(lng) ||
    lat < -90 ||
    lat > 90 ||
    lng < -180 ||
    lng > 180
  ) {
    return NextResponse.json({ ok: false }, { status: 400 });
  }
  const result = await updateDriverLocation(token, lat, lng);
  return NextResponse.json(result);
}
