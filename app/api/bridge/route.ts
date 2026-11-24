// /api/bridge — the kitchen print bridge's API (POST only).
//
// The bridge is the small program on the kitchen computer
// (print-bridge/bridge.js). It is NOT a staff login: it pairs once
// with a 6-digit code from Admin → Operations → Kitchen printer and
// then authenticates with its own token in the `x-bridge-token`
// header. Only the token's SHA-256 hash is stored (site_settings).
// Auth fails CLOSED — no/invalid token, no service.
//
// Actions (JSON body):
//   { action: "pair", code, computer_name }        -> { token } (once)
//   { action: "sync", computer_name, printers?, rescan_done? }
//        -> { selected_printer, copies, rescan_requested, pairing_valid }
//   { action: "jobs" }                             -> { jobs: [...] }
//   { action: "ack", job_id, ok, error? }          -> { ok: true }

import { NextResponse } from "next/server";
import { supabaseConfigured } from "@/lib/supabase/server";
import {
  authenticateBridge,
  bridgeAck,
  bridgeJobs,
  bridgeSync,
  pairBridge,
} from "@/lib/printer";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ service: "madinah-print-bridge", ok: true });
}

export async function POST(req: Request) {
  if (!supabaseConfigured()) {
    return NextResponse.json(
      { error: "Database is not configured." },
      { status: 503 }
    );
  }
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }
  try {
    switch (body.action) {
      case "pair": {
        const code = String(body.code ?? "").trim();
        const computerName = String(body.computer_name ?? "").trim();
        if (!/^\d{6}$/.test(code)) {
          throw new Error("Enter the 6-digit pairing code from Admin.");
        }
        const { token } = await pairBridge(code, computerName);
        // The ONLY time the raw token ever leaves the server.
        return NextResponse.json({ token });
      }
      case "sync":
      case "jobs":
      case "ack": {
        const store = await authenticateBridge(req.headers.get("x-bridge-token"));
        if (!store) {
          return NextResponse.json(
            {
              error:
                "Bridge token missing or invalid — pair again from Admin → Operations → Kitchen printer.",
            },
            { status: 401 }
          );
        }
        if (body.action === "sync") {
          const result = await bridgeSync(store, {
            computer_name: body.computer_name,
            printers: body.printers,
            rescan_done: body.rescan_done,
          });
          return NextResponse.json(result);
        }
        if (body.action === "jobs") {
          const jobs = await bridgeJobs(store);
          return NextResponse.json({ jobs });
        }
        // ack
        const jobId = String(body.job_id ?? "");
        if (!jobId) throw new Error("Missing job_id");
        await bridgeAck(
          store,
          jobId,
          body.ok === true,
          typeof body.error === "string" ? body.error : null
        );
        return NextResponse.json({ ok: true });
      }
      default:
        return NextResponse.json({ error: "Unknown action" }, { status: 400 });
    }
  } catch (err) {
    console.error("[bridge] action failed:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Bridge action failed" },
      { status: 400 }
    );
  }
}
