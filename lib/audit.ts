// Admin audit log — server-side only (service-role client).
// Written on a BEST-EFFORT basis from the admin API routes: a missing
// admin_audit table (supabase/admin-panel-schema.sql not run yet) or any
// other logging failure is swallowed so it can never break the mutation
// it describes. Reads fail soft the same way and report `available:false`
// so the panel can show a friendly "run the SQL" note instead of an error.

import { getServiceClient } from "./supabase/server";

export interface AuditEntry {
  id: number;
  actor: string | null;
  action: string;
  detail: Record<string, unknown>;
  created_at: string;
}

/** Records one admin action. Never throws. */
export async function logAudit(
  actor: string | null,
  action: string,
  detail: Record<string, unknown> = {}
): Promise<void> {
  try {
    const supabase = getServiceClient();
    const { error } = await supabase
      .from("admin_audit")
      .insert({ actor, action, detail });
    if (error) {
      console.warn("[audit] insert skipped:", error.message);
    }
  } catch (err) {
    console.warn("[audit] insert skipped:", err);
  }
}

/** Latest audit entries, newest first. Never throws. */
export async function listAudit(
  limit = 100
): Promise<{ available: boolean; entries: AuditEntry[] }> {
  try {
    const supabase = getServiceClient();
    const { data, error } = await supabase
      .from("admin_audit")
      .select("id, actor, action, detail, created_at")
      .order("created_at", { ascending: false })
      .limit(limit);
    if (error) return { available: false, entries: [] };
    return { available: true, entries: (data as AuditEntry[]) ?? [] };
  } catch {
    return { available: false, entries: [] };
  }
}
