// Kitchen Printer — print-bridge state, pairing, jobs and tickets.
//
// The website runs in the cloud and cannot see the restaurant's
// printers, so a small bridge program on the kitchen computer
// (print-bridge/bridge.js) does the discovering and the printing.
// This module is the server half: pairing codes, the bridge token,
// bridge state, the print-job feed and the ticket text. The bridge
// stays dumb — every ticket arrives fully formatted.
//
// Storage: site_settings rows (the table already exists; values are
// jsonb). Four keys, deliberately separated so writers don't collide:
//   printer_token    string — SHA-256 hash of the bridge token. The
//                    raw token exists only on the kitchen computer
//                    and in the one pairing response that created it.
//   printer_pairing  { code, code_hash, expires_at } — the open
//                    6-digit pairing code (15 min, single use). The
//                    plaintext code is kept so the admin card can keep
//                    showing it until it is used or expires; the table
//                    is service-role only and none of these keys are
//                    ever included in the public /api/admin GET.
//   printer_state    BridgeState — written by the bridge endpoints.
//   printer_config   PrinterConfig — written by the admin actions
//                    (selected printer, copies, test ticket, rescan).
//
// FAIL RULES: admin reads fail soft (the card shows "not paired"
// rather than breaking Operations); bridge auth fails CLOSED (any
// doubt → 401). Pairing fails closed too: if the paid-order cutoff
// cannot be snapshotted, pairing errors out instead of risking a
// backlog of old orders printing on first connect.

import { createHash, randomBytes, randomInt, timingSafeEqual } from "crypto";
import { getServiceClient } from "./supabase/server";
import { formatCents, MENU_BY_ID } from "./menu";
import { getPricingMenuById } from "./menuDb";
import { formatDenverTime } from "./hours";
import { encodeQr, qrModuleString } from "./qrcode";
import { siteUrl } from "./stripe";

// ---- Types --------------------------------------------------------------------

export interface BridgePrinter {
  name: string;
  is_default: boolean;
  status: string;
}

export interface BridgeState {
  computer_name: string | null;
  last_seen_at: string | null;
  printers: BridgePrinter[];
  paired_at: string | null;
  /** Only orders with id > cutoff are ever offered to the bridge. */
  cutoff_order_id: number;
  /** Order ids confirmed printed, most recent last, capped at 300. */
  printed_ids: number[];
  /** order id (string key) -> failed attempt count; >= 3 = parked. */
  attempts: Record<string, number>;
  /** Id of the last test ticket the bridge finished (ok or not). */
  test_done_id: string | null;
  rescan_done_at: string | null;
  last_error: string | null;
}

export interface PrinterConfig {
  selected_printer: string | null;
  copies: number; // 1–3
  test_job: { id: string; requested_at: string } | null;
  rescan_requested_at: string | null;
  /**
   * Print ON/OFF switch (Admin → Operations). Missing = ON, so a
   * config written before this field existed keeps printing.
   */
  enabled: boolean;
}

export interface PairingInfo {
  code: string;
  code_hash: string;
  expires_at: string;
}

export interface PrinterStore {
  tokenHash: string | null;
  pairing: PairingInfo | null;
  state: BridgeState;
  config: PrinterConfig;
}

/** The slice of an orders row a ticket needs (the stored shape). */
export interface TicketOrder {
  id: number;
  customer_name: string | null;
  customer_phone: string | null;
  fulfillment: string;
  delivery_address: string | null;
  /** Curbside car text — absent until supabase/curbside-schema.sql runs. */
  car_description?: string | null;
  /** Order-level checkout note — absent until supabase/order-note-schema.sql runs. */
  note?: string | null;
  /** House Delivery — provider/token, absent until their columns exist. */
  delivery_provider?: string | null;
  driver_token?: string | null;
  items_json: {
    id?: string;
    name: string;
    qty: number;
    line_total_cents: number;
    options?: { group?: string; name: string; price_delta_cents?: number }[];
    instructions?: string;
  }[];
  subtotal_cents: number;
  discount_cents?: number;
  service_fee_cents?: number;
  tax_cents: number;
  delivery_fee_cents: number;
  delivery_markup_cents?: number;
  free_delivery?: boolean;
  tip_cents: number;
  total_cents: number;
  created_at: string;
  scheduled_for?: string | null;
}

export interface PrintJob {
  job_id: string; // "order:<id>" | "test:<id>"
  kind: "order" | "test";
  order_id?: number;
  printer: string | null;
  copies: number;
  ticket: string;
  /**
   * House Delivery driver QR (null for every other job — Sami's
   * rule: QR exists ONLY on house-delivery tickets). The module map
   * of the driver-page link, drawn by printer app v1.6+ in place of
   * the ticket's @@QR@@ marker line. Older apps ignore the field.
   */
  qr?: { size: number; data: string } | null;
  /** Driver-page URL for Bluetooth printers, whose built-in QR
   * command needs the text itself (the module map above is for the
   * LAN raster path). Null unless this is a House Delivery order. */
  qr_url?: string | null;
}

/**
 * The driver-page URL for a house order, or null when the order is
 * not a house delivery (or has no token yet). This is the ONLY
 * source of driver QR links — ticket, kitchen board and admin all
 * derive from the same token.
 */
export function driverUrlForOrder(order: {
  fulfillment: string;
  delivery_provider?: string | null;
  driver_token?: string | null;
}): string | null {
  if (order.fulfillment !== "delivery") return null;
  if (order.delivery_provider !== "house") return null;
  if (!order.driver_token) return null;
  return `${siteUrl()}/d/${order.driver_token}`;
}

export interface PrinterAdminView {
  paired: boolean;
  connected: boolean;
  computer_name: string | null;
  last_seen_at: string | null;
  printers: BridgePrinter[];
  selected_printer: string | null;
  copies: number;
  pairing_code: string | null;
  pairing_expires_at: string | null;
  test_pending: boolean;
  last_error: string | null;
  parked_count: number;
  /** Print ON/OFF switch state (default ON). */
  enabled: boolean;
}

// ---- Constants ------------------------------------------------------------------

const TOKEN_KEY = "printer_token";
const PAIRING_KEY = "printer_pairing";
const STATE_KEY = "printer_state";
const CONFIG_KEY = "printer_config";

export const PAIRING_TTL_MS = 15 * 60 * 1000;
export const CONNECTED_WITHIN_MS = 60 * 1000;
export const MAX_PRINT_ATTEMPTS = 3;
export const PRINTED_CAP = 300;
export const TICKET_WIDTH = 48;
const MAX_JOBS_PER_POLL = 20;

export const DEFAULT_BRIDGE_STATE: BridgeState = {
  computer_name: null,
  last_seen_at: null,
  printers: [],
  paired_at: null,
  cutoff_order_id: 0,
  printed_ids: [],
  attempts: {},
  test_done_id: null,
  rescan_done_at: null,
  last_error: null,
};

export const DEFAULT_PRINTER_CONFIG: PrinterConfig = {
  selected_printer: null,
  copies: 1,
  test_job: null,
  rescan_requested_at: null,
  enabled: true,
};

// ---- Pure helpers (harness-tested) ----------------------------------------------

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Constant-time check of a presented bridge token against the stored hash. */
export function tokenMatches(token: string, storedHash: string | null): boolean {
  if (!token || !storedHash) return false;
  const presented = Buffer.from(sha256Hex(token), "utf8");
  const stored = Buffer.from(storedHash, "utf8");
  if (presented.length !== stored.length) return false;
  return timingSafeEqual(presented, stored);
}

export function newPairingCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

export type PairingCheck = "ok" | "none" | "expired" | "mismatch";

/** Validates a presented code against the stored pairing (pure). */
export function pairingCheck(
  pairing: PairingInfo | null,
  code: string,
  nowMs: number
): PairingCheck {
  if (!pairing) return "none";
  if (nowMs > Date.parse(pairing.expires_at)) return "expired";
  const presented = Buffer.from(sha256Hex(code.trim()), "utf8");
  const stored = Buffer.from(pairing.code_hash, "utf8");
  if (presented.length !== stored.length || !timingSafeEqual(presented, stored)) {
    return "mismatch";
  }
  return "ok";
}

/** Connected = a sync heartbeat landed within the last 60 seconds. */
export function isBridgeConnected(lastSeenAt: string | null, nowMs: number): boolean {
  if (!lastSeenAt) return false;
  const seen = Date.parse(lastSeenAt);
  return Number.isFinite(seen) && nowMs - seen <= CONNECTED_WITHIN_MS;
}

/** A queued test ticket the bridge has not finished yet. */
export function testJobPending(state: BridgeState, config: PrinterConfig): boolean {
  return Boolean(config.test_job) && state.test_done_id !== config.test_job?.id;
}

/**
 * The orders (already filtered to paid + not cancelled by the caller)
 * that the bridge should print now: after the pairing cutoff, not yet
 * printed, and not parked after repeated failures. Oldest first.
 */
export function pendingOrderJobs<T extends { id: number }>(
  state: BridgeState,
  orders: T[]
): T[] {
  const printed = new Set(state.printed_ids);
  return orders
    .filter((o) => o.id > state.cutoff_order_id)
    .filter((o) => !printed.has(o.id))
    .filter((o) => (state.attempts[String(o.id)] ?? 0) < MAX_PRINT_ATTEMPTS)
    .sort((a, b) => a.id - b.id);
}

/**
 * Composes one poll's job list (pure): the queued TEST ticket first —
 * it flows even while printing is OFF, so Test print always works —
 * then the pending order tickets, but ONLY when printing is enabled.
 * `orders` must already be filtered to paid + not cancelled.
 */
export function composeJobs(
  state: BridgeState,
  config: PrinterConfig,
  orders: TicketOrder[],
  numbers: Record<string, string>,
  nowIso: string
): PrintJob[] {
  const jobs: PrintJob[] = [];
  if (testJobPending(state, config) && config.test_job) {
    jobs.push({
      job_id: `test:${config.test_job.id}`,
      kind: "test",
      printer: config.selected_printer,
      copies: config.copies,
      ticket: buildTestTicketText(nowIso),
    });
  }
  if (!config.enabled) return jobs;
  const pending = pendingOrderJobs(state, orders).slice(0, MAX_JOBS_PER_POLL);
  for (const order of pending) {
    // House Delivery only: the driver QR rides inside the job (the
    // website encodes it; the app just draws the modules).
    const driverUrl = driverUrlForOrder(order);
    const qrMatrix = driverUrl ? encodeQr(driverUrl) : null;
    jobs.push({
      job_id: `order:${order.id}`,
      kind: "order",
      order_id: order.id,
      printer: config.selected_printer,
      copies: config.copies,
      ticket: buildTicketText(order, numbers, driverUrl),
      qr: qrMatrix ? { size: qrMatrix.size, data: qrModuleString(qrMatrix) } : null,
      qr_url: driverUrl,
    });
  }
  return jobs;
}

/**
 * The cutoff after an OFF→ON flip (pure): advance to the current max
 * paid order id, never backwards — orders paid while printing was OFF
 * are skipped instead of flooding the printer when it comes back on.
 */
export function cutoffAfterEnable(state: BridgeState, maxPaidOrderId: number): number {
  return Math.max(state.cutoff_order_id, Math.max(0, Math.floor(maxPaidOrderId) || 0));
}

/**
 * Applies one bridge ack to the state (pure — returns a new object).
 * A successful order ack is exactly-once: the id joins printed_ids and
 * the job can never be offered again. A failed ack counts an attempt;
 * at MAX_PRINT_ATTEMPTS the job parks (pendingOrderJobs excludes it)
 * and the error is kept for the admin card. A test ack — success OR
 * failure — completes that test ticket (one attempt per queueing;
 * staff press Test print again for another try).
 */
export function applyAck(
  state: BridgeState,
  job: { kind: "order"; order_id: number } | { kind: "test"; test_id: string },
  ok: boolean,
  error: string | null
): BridgeState {
  const next: BridgeState = {
    ...state,
    printed_ids: [...state.printed_ids],
    attempts: { ...state.attempts },
  };
  const message = (error ?? "").trim().slice(0, 300) || "Print failed";
  if (job.kind === "test") {
    next.test_done_id = job.test_id;
    next.last_error = ok ? null : message;
    return next;
  }
  const key = String(job.order_id);
  if (ok) {
    if (!next.printed_ids.includes(job.order_id)) {
      next.printed_ids.push(job.order_id);
    }
    if (next.printed_ids.length > PRINTED_CAP) {
      next.printed_ids = next.printed_ids.slice(-PRINTED_CAP);
    }
    delete next.attempts[key];
    next.last_error = null;
  } else {
    next.attempts[key] = (next.attempts[key] ?? 0) + 1;
    next.last_error = message;
  }
  return next;
}

/** Sanitizes a printer list reported by the bridge (pure). */
export function sanitizePrinters(raw: unknown): BridgePrinter[] {
  if (!Array.isArray(raw)) return [];
  const out: BridgePrinter[] = [];
  for (const entry of raw.slice(0, 50)) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const name = typeof e.name === "string" ? e.name.trim().slice(0, 120) : "";
    if (!name) continue;
    out.push({
      name,
      is_default: e.is_default === true,
      status: typeof e.status === "string" ? e.status.trim().slice(0, 40) : "Unknown",
    });
  }
  return out;
}

export function normalizeState(raw: unknown): BridgeState {
  const base = { ...DEFAULT_BRIDGE_STATE };
  if (!raw || typeof raw !== "object") return base;
  const r = raw as Record<string, unknown>;
  return {
    computer_name: typeof r.computer_name === "string" ? r.computer_name : null,
    last_seen_at: typeof r.last_seen_at === "string" ? r.last_seen_at : null,
    printers: sanitizePrinters(r.printers),
    paired_at: typeof r.paired_at === "string" ? r.paired_at : null,
    cutoff_order_id:
      typeof r.cutoff_order_id === "number" && Number.isFinite(r.cutoff_order_id)
        ? Math.max(0, Math.floor(r.cutoff_order_id))
        : 0,
    printed_ids: Array.isArray(r.printed_ids)
      ? r.printed_ids
          .filter((n): n is number => typeof n === "number" && Number.isFinite(n))
          .slice(-PRINTED_CAP)
      : [],
    attempts:
      r.attempts && typeof r.attempts === "object"
        ? Object.fromEntries(
            Object.entries(r.attempts as Record<string, unknown>).filter(
              (e): e is [string, number] =>
                typeof e[1] === "number" && Number.isFinite(e[1]) && e[1] > 0
            )
          )
        : {},
    test_done_id: typeof r.test_done_id === "string" ? r.test_done_id : null,
    rescan_done_at: typeof r.rescan_done_at === "string" ? r.rescan_done_at : null,
    last_error: typeof r.last_error === "string" ? r.last_error : null,
  };
}

export function normalizeConfig(raw: unknown): PrinterConfig {
  const base = { ...DEFAULT_PRINTER_CONFIG };
  if (!raw || typeof raw !== "object") return base;
  const r = raw as Record<string, unknown>;
  const copies =
    typeof r.copies === "number" && Number.isFinite(r.copies)
      ? Math.min(3, Math.max(1, Math.floor(r.copies)))
      : 1;
  const testJob =
    r.test_job && typeof r.test_job === "object"
      ? (r.test_job as Record<string, unknown>)
      : null;
  return {
    selected_printer:
      typeof r.selected_printer === "string" && r.selected_printer.trim()
        ? r.selected_printer.slice(0, 120)
        : null,
    copies,
    test_job:
      testJob && typeof testJob.id === "string" && testJob.id
        ? {
            id: testJob.id,
            requested_at:
              typeof testJob.requested_at === "string"
                ? testJob.requested_at
                : new Date(0).toISOString(),
          }
        : null,
    rescan_requested_at:
      typeof r.rescan_requested_at === "string" ? r.rescan_requested_at : null,
    // Only an explicit false turns printing off — anything else
    // (missing key, older config, junk) means ON.
    enabled: r.enabled === false ? false : true,
  };
}

// ---- Ticket text (pure) -----------------------------------------------------------

const W = TICKET_WIDTH;

function center(text: string): string {
  const t = text.slice(0, W);
  const pad = Math.max(0, Math.floor((W - t.length) / 2));
  return " ".repeat(pad) + t;
}

/** Word-wraps text to the ticket width; every returned line is <= W. */
function wrap(text: string, indent = 0, hangIndent = indent): string[] {
  const words = text.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  if (words.length === 0) return [];
  const lines: string[] = [];
  let current = " ".repeat(indent);
  let curIndent = indent;
  for (const word of words) {
    const candidate = current.trim() === "" ? current + word : `${current} ${word}`;
    if (candidate.length <= W) {
      current = candidate;
    } else {
      if (current.trim() !== "") lines.push(current);
      curIndent = hangIndent;
      current = " ".repeat(curIndent) + word;
      // A single word longer than the width is hard-split.
      while (current.length > W) {
        lines.push(current.slice(0, W));
        current = " ".repeat(curIndent) + current.slice(W).trimStart();
      }
    }
  }
  if (current.trim() !== "") lines.push(current);
  return lines;
}

/** "Label .......... $1.23" on one line when it fits, else label lines + amount line. */
function moneyRow(label: string, amount: string): string[] {
  if (label.length + 1 + amount.length <= W) {
    return [label + " ".repeat(W - label.length - amount.length) + amount];
  }
  return [...wrap(label), " ".repeat(Math.max(0, W - amount.length)) + amount];
}

function denverDateTime(iso: string): string {
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Denver",
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

/**
 * The plain-text kitchen ticket for one order — the same content as
 * the /kitchen page's printed ticket (same merged delivery-fee rule:
 * DoorDash fee + markup as ONE line, FREE under the promotion), laid
 * out for an 80mm roll at 48 characters per line.
 */
export function buildTicketText(
  order: TicketOrder,
  numbers?: Record<string, string>,
  driverUrl?: string | null
): string {
  const lines: string[] = [];
  const rule = "=".repeat(W);
  const dash = "-".repeat(W);
  lines.push(
    rule,
    center("MADINAH MARKET"),
    center("www.taqwaacenter.com"),
    center("720-763-0786"),
    rule
  );
  lines.push(center(`ORDER #${order.id}`));
  lines.push(
    center(
      order.fulfillment === "delivery"
        ? order.delivery_provider === "house"
          ? "HOUSE DELIVERY"
          : "DELIVERY"
        : order.fulfillment === "curbside"
          ? "CURBSIDE"
          : "PICKUP"
    )
  );
  lines.push(center(denverDateTime(order.created_at)));
  if (order.scheduled_for) {
    lines.push(center(`** PICKUP AT ${formatDenverTime(order.scheduled_for)} **`));
  }
  lines.push(dash);
  if (order.customer_name?.trim()) lines.push(...wrap(`Customer: ${order.customer_name.trim()}`));
  if (order.customer_phone?.trim()) lines.push(...wrap(`Phone: ${order.customer_phone.trim()}`));
  if (order.fulfillment === "curbside" && order.car_description?.trim()) {
    lines.push(...wrap(`CAR: ${order.car_description.trim()}`));
  }
  if (order.fulfillment === "delivery" && order.delivery_address?.trim()) {
    lines.push(...wrap(`DELIVERY: ${order.delivery_address.trim()}`));
  }
  if (order.note?.trim()) {
    lines.push(...wrap(`NOTE: ${order.note.trim()}`));
  }
  lines.push(dash);
  for (const line of order.items_json ?? []) {
    const num = line.id ? numbers?.[line.id] : undefined;
    const name =
      num && !line.name.startsWith("#") ? `${num} ${line.name}` : line.name;
    lines.push(...moneyRow(`${line.qty} x ${name}`, formatCents(line.line_total_cents)));
    for (const opt of line.options ?? []) {
      lines.push(
        ...moneyRow(
          `  + ${opt.name}`,
          formatCents((opt.price_delta_cents ?? 0) * line.qty)
        )
      );
    }
    if (line.instructions?.trim()) {
      lines.push(...wrap(`NOTE: ${line.instructions.trim()}`, 2, 4));
    }
  }
  lines.push(dash);
  lines.push(...moneyRow("Subtotal", formatCents(order.subtotal_cents)));
  if ((order.discount_cents ?? 0) > 0) {
    lines.push(...moneyRow("Loyalty discount", `-${formatCents(order.discount_cents ?? 0)}`));
  }
  if ((order.service_fee_cents ?? 0) > 0) {
    lines.push(...moneyRow("Service fee", formatCents(order.service_fee_cents ?? 0)));
  }
  lines.push(...moneyRow("Tax", formatCents(order.tax_cents)));
  if (order.fulfillment === "delivery") {
    const charge = order.free_delivery
      ? 0
      : order.delivery_fee_cents + (order.delivery_markup_cents ?? 0);
    lines.push(
      ...moneyRow("Delivery fee", order.free_delivery ? "FREE" : formatCents(charge))
    );
  }
  if (order.tip_cents > 0) {
    lines.push(...moneyRow("Tip", formatCents(order.tip_cents)));
  }
  lines.push(...moneyRow("TOTAL", formatCents(order.total_cents)));
  // House Delivery ONLY (Sami's rule — DoorDash/Shipday tickets
  // never carry a QR): the driver scans this code on the paper
  // ticket to get the address in Google Maps plus the customer
  // details. The @@QR@@ marker line is where printer app v1.6+
  // draws the real QR image (the module map rides in the job).
  if (driverUrl) {
    lines.push(
      dash,
      center("** HOUSE DELIVERY **"),
      center("DRIVER: SCAN FOR DIRECTIONS"),
      "@@QR@@"
    );
  }
  lines.push(rule, center("Thank you!"), "");
  return lines.join("\n");
}

/** The queued test ticket — unmistakable, so it is never confused with an order. */
export function buildTestTicketText(nowIso: string): string {
  const rule = "=".repeat(W);
  const lines = [
    rule,
    center("MADINAH MARKET"),
    center("www.taqwaacenter.com"),
    center("720-763-0786"),
    rule,
    "",
    center("*** TEST PRINT ***"),
    "",
    center("If you can read this, the kitchen"),
    center("printer is connected and working."),
    "",
    center(denverDateTime(nowIso)),
    rule,
    "",
  ];
  return lines.join("\n");
}

// ---- Storage (site_settings) -------------------------------------------------------

async function readKey(key: string): Promise<unknown> {
  try {
    const supabase = getServiceClient();
    const { data, error } = await supabase
      .from("site_settings")
      .select("value")
      .eq("key", key)
      .maybeSingle();
    if (error || !data) return null;
    return (data as { value: unknown }).value ?? null;
  } catch {
    return null;
  }
}

async function writeKey(key: string, value: unknown): Promise<void> {
  const supabase = getServiceClient();
  const { error } = await supabase
    .from("site_settings")
    .upsert(
      { key, value, updated_at: new Date().toISOString() },
      { onConflict: "key" }
    );
  if (error) throw error;
}

async function deleteKey(key: string): Promise<void> {
  const supabase = getServiceClient();
  const { error } = await supabase.from("site_settings").delete().eq("key", key);
  if (error) throw error;
}

export async function getPrinterStore(): Promise<PrinterStore> {
  const [tokenRaw, pairingRaw, stateRaw, configRaw] = await Promise.all([
    readKey(TOKEN_KEY),
    readKey(PAIRING_KEY),
    readKey(STATE_KEY),
    readKey(CONFIG_KEY),
  ]);
  const pairing =
    pairingRaw && typeof pairingRaw === "object"
      ? (pairingRaw as PairingInfo)
      : null;
  return {
    tokenHash: typeof tokenRaw === "string" && tokenRaw ? tokenRaw : null,
    pairing:
      pairing && typeof pairing.code_hash === "string" && typeof pairing.expires_at === "string"
        ? pairing
        : null,
    state: normalizeState(stateRaw),
    config: normalizeConfig(configRaw),
  };
}

async function saveState(state: BridgeState): Promise<void> {
  await writeKey(STATE_KEY, state);
}

async function saveConfig(config: PrinterConfig): Promise<void> {
  await writeKey(CONFIG_KEY, config);
}

// ---- Admin side ----------------------------------------------------------------------

/** Everything the Operations "Kitchen printer" card needs. Fail-soft. */
export async function getPrinterAdminView(): Promise<PrinterAdminView> {
  const empty: PrinterAdminView = {
    paired: false,
    connected: false,
    computer_name: null,
    last_seen_at: null,
    printers: [],
    selected_printer: null,
    copies: 1,
    pairing_code: null,
    pairing_expires_at: null,
    test_pending: false,
    last_error: null,
    parked_count: 0,
    enabled: true,
  };
  try {
    const store = await getPrinterStore();
    const now = Date.now();
    const pairingOpen =
      store.pairing && Date.parse(store.pairing.expires_at) > now ? store.pairing : null;
    return {
      paired: Boolean(store.tokenHash),
      connected: isBridgeConnected(store.state.last_seen_at, now),
      computer_name: store.state.computer_name,
      last_seen_at: store.state.last_seen_at,
      printers: store.state.printers,
      selected_printer: store.config.selected_printer,
      copies: store.config.copies,
      pairing_code: pairingOpen ? pairingOpen.code : null,
      pairing_expires_at: pairingOpen ? pairingOpen.expires_at : null,
      test_pending: testJobPending(store.state, store.config),
      last_error: store.state.last_error,
      parked_count: Object.values(store.state.attempts).filter(
        (n) => n >= MAX_PRINT_ATTEMPTS
      ).length,
      enabled: store.config.enabled,
    };
  } catch {
    return empty;
  }
}

/** Opens a fresh 15-minute pairing window and returns the code to show. */
export async function generatePairingCode(): Promise<{ code: string; expires_at: string }> {
  const code = newPairingCode();
  const expires_at = new Date(Date.now() + PAIRING_TTL_MS).toISOString();
  const pairing: PairingInfo = { code, code_hash: sha256Hex(code), expires_at };
  await writeKey(PAIRING_KEY, pairing);
  return { code, expires_at };
}

/** Revoke / re-pair: kills the token and clears all bridge state. */
export async function revokeBridge(): Promise<void> {
  const store = await getPrinterStore();
  await deleteKey(TOKEN_KEY);
  await deleteKey(PAIRING_KEY);
  await deleteKey(STATE_KEY);
  await saveConfig({ ...store.config, test_job: null, rescan_requested_at: null });
}

export async function selectPrinter(name: string | null): Promise<void> {
  const store = await getPrinterStore();
  await saveConfig({ ...store.config, selected_printer: name });
}

export async function setPrinterCopies(copies: number): Promise<void> {
  const store = await getPrinterStore();
  await saveConfig({
    ...store.config,
    copies: Math.min(3, Math.max(1, Math.floor(copies))),
  });
}

export async function requestRescan(): Promise<void> {
  const store = await getPrinterStore();
  await saveConfig({ ...store.config, rescan_requested_at: new Date().toISOString() });
}

/** The highest paid/test_paid order id right now (0 when there are none). */
async function maxPaidOrderId(): Promise<number> {
  const supabase = getServiceClient();
  const { data, error } = await supabase
    .from("orders")
    .select("id")
    .in("payment_status", ["paid", "test_paid"])
    .order("id", { ascending: false })
    .limit(1);
  if (error) throw new Error("Could not read the orders table.");
  return data && data.length > 0 ? Number((data[0] as { id: unknown }).id) || 0 : 0;
}

/**
 * The print ON/OFF switch (Admin → Operations → Kitchen printer).
 * Turning OFF just stops the jobs feed handing out order tickets (the
 * bridge program is unchanged; a queued test ticket still flows).
 * Turning back ON first advances the print cutoff to the current max
 * paid order id — the same snapshot mechanism as pairing — so orders
 * paid while OFF are skipped rather than printing all at once.
 */
export async function setPrinterEnabled(enabled: boolean): Promise<void> {
  const store = await getPrinterStore();
  if (enabled && !store.config.enabled) {
    const cutoff = cutoffAfterEnable(store.state, await maxPaidOrderId());
    if (cutoff !== store.state.cutoff_order_id) {
      await saveState({ ...store.state, cutoff_order_id: cutoff });
    }
  }
  await saveConfig({ ...store.config, enabled });
}

/** Queues a one-shot test ticket for the bridge's next poll. */
export async function queueTestPrint(): Promise<void> {
  const store = await getPrinterStore();
  const id = randomBytes(6).toString("hex");
  await saveConfig({
    ...store.config,
    test_job: { id, requested_at: new Date().toISOString() },
  });
}

// ---- Bridge side -----------------------------------------------------------------------

/**
 * Exchanges a pairing code for the bridge token. The code is consumed
 * (single use) and the paid-order cutoff is snapshotted NOW, so the
 * bridge only ever prints orders paid after pairing. The raw token is
 * returned exactly once — only its hash is stored.
 */
export async function pairBridge(
  code: string,
  computerName: string
): Promise<{ token: string }> {
  const store = await getPrinterStore();
  const check = pairingCheck(store.pairing, code, Date.now());
  if (check === "none") {
    throw new Error("No pairing code is open — generate one in Admin → Operations first.");
  }
  if (check === "expired") {
    throw new Error("That pairing code has expired — generate a new one in Admin.");
  }
  if (check === "mismatch") {
    throw new Error("Wrong pairing code — check the six digits in Admin and try again.");
  }
  // Snapshot the cutoff BEFORE issuing the token (fail closed: if the
  // orders table cannot be read, pairing fails rather than risking a
  // backlog print on first connect).
  let cutoff: number;
  try {
    cutoff = await maxPaidOrderId();
  } catch {
    throw new Error("Could not read the orders table — pairing stopped, try again.");
  }

  const token = randomBytes(32).toString("hex");
  const now = new Date().toISOString();
  await writeKey(TOKEN_KEY, sha256Hex(token));
  await deleteKey(PAIRING_KEY);
  await saveState({
    ...DEFAULT_BRIDGE_STATE,
    computer_name: computerName.trim().slice(0, 80) || null,
    last_seen_at: now,
    paired_at: now,
    cutoff_order_id: cutoff,
  });
  return { token };
}

/** Validates the x-bridge-token header. Returns the store, or null (fail closed). */
export async function authenticateBridge(
  token: string | null
): Promise<PrinterStore | null> {
  if (!token) return null;
  const store = await getPrinterStore();
  if (!tokenMatches(token, store.tokenHash)) return null;
  return store;
}

/** True when a rescan was requested after the bridge's last completed scan. */
export function rescanOutstanding(state: BridgeState, config: PrinterConfig): boolean {
  if (!config.rescan_requested_at) return false;
  if (!state.rescan_done_at) return true;
  return Date.parse(config.rescan_requested_at) > Date.parse(state.rescan_done_at);
}

/**
 * Heartbeat: records last-seen, the computer name and (when sent) the
 * printer list; reports back the admin's current choices.
 */
export async function bridgeSync(
  store: PrinterStore,
  input: { computer_name?: unknown; printers?: unknown; rescan_done?: unknown }
): Promise<{
  selected_printer: string | null;
  copies: number;
  rescan_requested: boolean;
  pairing_valid: boolean;
}> {
  const state: BridgeState = { ...store.state, last_seen_at: new Date().toISOString() };
  if (typeof input.computer_name === "string" && input.computer_name.trim()) {
    state.computer_name = input.computer_name.trim().slice(0, 80);
  }
  if (input.printers !== undefined) {
    state.printers = sanitizePrinters(input.printers);
  }
  if (input.rescan_done === true && store.config.rescan_requested_at) {
    state.rescan_done_at = store.config.rescan_requested_at;
  }
  await saveState(state);
  return {
    selected_printer: store.config.selected_printer,
    copies: store.config.copies,
    rescan_requested: rescanOutstanding(state, store.config),
    pairing_valid: true,
  };
}

/** Menu numbers ("#13") for ticket item names: live menu, built-in fallback. */
async function resolveMenuNumbers(): Promise<Record<string, string>> {
  const numbers: Record<string, string> = {};
  try {
    const byId = await getPricingMenuById();
    for (const [id, item] of Object.entries(byId)) {
      if (item.number) numbers[id] = item.number;
    }
  } catch {
    /* fall through to the built-in menu */
  }
  if (Object.keys(numbers).length === 0) {
    for (const [id, item] of Object.entries(MENU_BY_ID)) {
      if (item.number) numbers[id] = item.number;
    }
  }
  return numbers;
}

/**
 * The pending print jobs for one bridge poll: test ticket first, then
 * orders. When the print switch is OFF the feed returns NO order jobs
 * (the queued test ticket still flows) — gating is entirely here on
 * the server; the bridge program is unchanged.
 */
export async function bridgeJobs(store: PrinterStore): Promise<PrintJob[]> {
  const { state, config } = store;
  const supabase = getServiceClient();
  // select("*") is deliberate: it picks up optional columns (car
  // text, the order note, ...) whenever their schema file has run and
  // simply omits them before that — printing can never break on a
  // not-yet-migrated database.
  const { data, error } = await supabase
    .from("orders")
    .select("*")
    .in("payment_status", ["paid", "test_paid"])
    .neq("kitchen_status", "cancelled")
    .gt("id", state.cutoff_order_id)
    .order("id", { ascending: true })
    .limit(100);
  if (error) throw error;
  const orders = (data as TicketOrder[]) ?? [];
  const needsNumbers =
    config.enabled && pendingOrderJobs(state, orders).length > 0;
  const numbers = needsNumbers ? await resolveMenuNumbers() : {};
  return composeJobs(state, config, orders, numbers, new Date().toISOString());
}

/** Records one print result. Exactly-once lives in applyAck. */
export async function bridgeAck(
  store: PrinterStore,
  jobId: string,
  ok: boolean,
  error: string | null
): Promise<void> {
  let next: BridgeState | null = null;
  if (jobId.startsWith("order:")) {
    const orderId = Math.floor(Number(jobId.slice("order:".length)));
    if (Number.isFinite(orderId) && orderId > 0) {
      next = applyAck(store.state, { kind: "order", order_id: orderId }, ok, error);
    }
  } else if (jobId.startsWith("test:")) {
    const testId = jobId.slice("test:".length);
    // Only the currently queued test ticket can be acked; a stale ack
    // for an old test id is ignored rather than completing a new one.
    if (store.config.test_job && store.config.test_job.id === testId) {
      next = applyAck(store.state, { kind: "test", test_id: testId }, ok, error);
    }
  }
  if (next) await saveState(next);
}
