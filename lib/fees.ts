// Service Fee + Free Delivery settings (site_settings) — server-side
// only (service-role client), same pattern as lib/delivery.ts
// getDeliverySettings. FAIL-SOFT RULE: any missing key, missing table
// or DB error reads as OFF / 0, so until the admin saves real values
// the site charges exactly what it charged before this feature.
//
// Keys:
//   service_fee_enabled            boolean
//   service_fee_type               'percent' | 'flat'
//   service_fee_percent            number (0–100)
//   service_fee_flat_cents         integer cents
//   free_delivery_enabled          boolean
//   free_delivery_threshold_cents  integer cents

import { getServiceClient } from "./supabase/server";
import {
  DEFAULT_FREE_DELIVERY,
  DEFAULT_SERVICE_FEE,
  type FreeDeliveryConfig,
  type ServiceFeeConfig,
} from "./feePricing";

export interface FeeSettings {
  service_fee: ServiceFeeConfig;
  free_delivery: FreeDeliveryConfig;
}

export const DEFAULT_FEE_SETTINGS: FeeSettings = {
  service_fee: { ...DEFAULT_SERVICE_FEE },
  free_delivery: { ...DEFAULT_FREE_DELIVERY },
};

const FEE_SETTING_KEYS = [
  "service_fee_enabled",
  "service_fee_type",
  "service_fee_percent",
  "service_fee_flat_cents",
  "free_delivery_enabled",
  "free_delivery_threshold_cents",
] as const;

function boolValue(value: unknown): boolean {
  return value === true || value === "true";
}

function numValue(value: unknown, fallback: number): number {
  const n = typeof value === "string" ? Number(value) : (value as number);
  return typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : fallback;
}

export async function getFeeSettings(): Promise<FeeSettings> {
  const settings: FeeSettings = {
    service_fee: { ...DEFAULT_SERVICE_FEE },
    free_delivery: { ...DEFAULT_FREE_DELIVERY },
  };
  try {
    const supabase = getServiceClient();
    const { data, error } = await supabase
      .from("site_settings")
      .select("key, value")
      .in("key", [...FEE_SETTING_KEYS]);
    if (error) return settings;
    for (const row of data ?? []) {
      const v = (row as { value: unknown }).value;
      switch (row.key as string) {
        case "service_fee_enabled":
          settings.service_fee.enabled = boolValue(v);
          break;
        case "service_fee_type":
          settings.service_fee.type = v === "flat" ? "flat" : "percent";
          break;
        case "service_fee_percent":
          settings.service_fee.percent = Math.min(numValue(v, 0), 100);
          break;
        case "service_fee_flat_cents":
          settings.service_fee.flat_cents = Math.round(numValue(v, 0));
          break;
        case "free_delivery_enabled":
          settings.free_delivery.enabled = boolValue(v);
          break;
        case "free_delivery_threshold_cents":
          settings.free_delivery.threshold_cents = Math.round(numValue(v, 0));
          break;
      }
    }
  } catch {
    /* defaults — both features OFF */
  }
  return settings;
}

async function upsertFeeRows(rows: { key: string; value: unknown }[]): Promise<void> {
  const supabase = getServiceClient();
  const now = new Date().toISOString();
  const { error } = await supabase
    .from("site_settings")
    .upsert(
      rows.map((r) => ({ key: r.key, value: r.value, updated_at: now })),
      { onConflict: "key" }
    );
  if (error) throw error;
}

export async function setServiceFeeSettings(input: ServiceFeeConfig): Promise<void> {
  await upsertFeeRows([
    { key: "service_fee_enabled", value: input.enabled === true },
    { key: "service_fee_type", value: input.type === "flat" ? "flat" : "percent" },
    { key: "service_fee_percent", value: Math.min(Math.max(input.percent || 0, 0), 100) },
    { key: "service_fee_flat_cents", value: Math.max(0, Math.round(input.flat_cents || 0)) },
  ]);
}

export async function setFreeDeliverySettings(input: FreeDeliveryConfig): Promise<void> {
  await upsertFeeRows([
    { key: "free_delivery_enabled", value: input.enabled === true },
    {
      key: "free_delivery_threshold_cents",
      value: Math.max(0, Math.round(input.threshold_cents || 0)),
    },
  ]);
}
