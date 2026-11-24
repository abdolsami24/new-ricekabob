// Loyalty points — server-side only (service-role client).
// Rules (2026-11-16, revised by Sami 2026-11-23):
// - Only signed-in customers (email or Google) earn or spend points.
// - Earn: 1 point per whole $1 of the PAID order total — always, from
//   the first order; the balance is visible right away.
// - Redeem: 100 points = $5.00 off, in whole 100-point blocks, never
//   more than the order subtotal — but ONLY when UNLOCKED: the
//   customer has spent $100+ on paid orders in the current calendar
//   month (America/Denver). The month total counts orders placed
//   before the current checkout, so the crossing order itself does
//   not get the discount — the next one does. Each month re-locks.
// - Expiry: points die 12 months after the day they are earned. The
//   spendable balance comes from a FIFO replay of the ledger (below).
// - A cancelled order refunds its redeemed points and reverses its
//   earned points. Every movement is one ledger row.
// - Idempotent: unique (order_id, reason) index makes re-runs no-ops.

import { getServiceClient } from "./supabase/server";

export const POINTS_PER_BLOCK = 100;
export const BLOCK_VALUE_CENTS = 500; // $5.00

/** Points die this many months after the day they are earned. */
export const POINTS_EXPIRY_MONTHS = 12;
/** Paid spend in one calendar month that unlocks redemption. */
export const UNLOCK_TARGET_CENTS = 10000; // $100.00
/** Loyalty months follow the restaurant's calendar. */
export const LOYALTY_TIMEZONE = "America/Denver";

interface LedgerRow {
  id: number;
  order_id: number | null;
  delta: number;
  reason: string;
  created_at: string;
}

async function loadLedger(userId: string): Promise<LedgerRow[]> {
  const supabase = getServiceClient();
  const { data, error } = await supabase
    .from("points_ledger")
    .select("id, order_id, delta, reason, created_at")
    .eq("user_id", userId)
    .order("created_at", { ascending: true })
    .order("id", { ascending: true })
    .limit(10000);
  if (error) throw error;
  return (data as LedgerRow[]) ?? [];
}

interface PointsBucket {
  orderId: number | null;
  atMs: number;
  remaining: number;
}

export interface PointsExpiry {
  points: number;
  expiresAt: string; // ISO instant
}

export interface PointsStatus {
  /** Spendable points right now (unexpired; usable when unlocked). */
  balance: number;
  /** Paid spend in the current loyalty month (Denver calendar). */
  monthSpentCents: number;
  unlockTargetCents: number;
  unlocked: boolean;
  remainingToUnlockCents: number;
  /** The next chunk of points to expire, if any. */
  nextExpiry: PointsExpiry | null;
}

function addMonthsMs(ms: number, months: number): number {
  const d = new Date(ms);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.getTime();
}

/**
 * FIFO replay of the ledger into earn buckets: redeems consume the
 * oldest points first; a cancellation refund restores exactly the
 * buckets its order's redeem consumed; an earn reversal drains its
 * own order's bucket first. Returns the buckets in earn order.
 */
function computeBuckets(rows: LedgerRow[]): PointsBucket[] {
  const buckets: PointsBucket[] = [];
  const consumptionByOrder = new Map<
    number,
    { bucket: PointsBucket; amount: number }[]
  >();
  const consume = (n: number, recordFor?: number) => {
    let left = n;
    const record: { bucket: PointsBucket; amount: number }[] = [];
    for (const b of buckets) {
      if (left <= 0) break;
      if (b.remaining <= 0) continue;
      const take = Math.min(b.remaining, left);
      b.remaining -= take;
      left -= take;
      record.push({ bucket: b, amount: take });
    }
    if (recordFor != null) consumptionByOrder.set(recordFor, record);
  };
  for (const row of rows) {
    const atMs = new Date(row.created_at).getTime();
    if (row.reason === "earn" && row.delta > 0) {
      buckets.push({ orderId: row.order_id, atMs, remaining: row.delta });
    } else if (row.reason === "redeem" && row.delta < 0) {
      consume(-row.delta, row.order_id ?? undefined);
    } else if (row.reason === "refund" && row.delta > 0) {
      // Restore the buckets this order's redeem consumed, newest first.
      let left = row.delta;
      const consumed =
        (row.order_id != null
          ? consumptionByOrder.get(row.order_id)
          : undefined) ?? [];
      for (let i = consumed.length - 1; i >= 0 && left > 0; i--) {
        const give = Math.min(consumed[i].amount, left);
        consumed[i].bucket.remaining += give;
        consumed[i].amount -= give;
        left -= give;
      }
      if (left > 0) {
        // Defensive: a refund with no recorded consumption (should not
        // happen) becomes a fresh bucket dated at the refund.
        buckets.push({ orderId: row.order_id, atMs, remaining: left });
      }
    } else if (row.reason === "reversal" && row.delta < 0) {
      let left = -row.delta;
      const own = buckets.find(
        (b) => b.orderId === row.order_id && b.remaining > 0
      );
      if (own) {
        const take = Math.min(own.remaining, left);
        own.remaining -= take;
        left -= take;
      }
      if (left > 0) consume(left);
    } else if (row.delta !== 0) {
      // Unknown future reason — keep the raw-sum behavior sane.
      if (row.delta > 0) {
        buckets.push({ orderId: row.order_id, atMs, remaining: row.delta });
      } else {
        consume(-row.delta);
      }
    }
  }
  return buckets;
}

function spendableFromBuckets(
  buckets: PointsBucket[],
  nowMs: number
): { balance: number; nextExpiry: PointsExpiry | null } {
  let balance = 0;
  let nextExpiry: PointsExpiry | null = null;
  for (const b of buckets) {
    if (b.remaining <= 0) continue;
    const expiresMs = addMonthsMs(b.atMs, POINTS_EXPIRY_MONTHS);
    if (expiresMs <= nowMs) continue; // expired — gone
    balance += b.remaining;
    if (!nextExpiry) {
      nextExpiry = {
        points: b.remaining,
        expiresAt: new Date(expiresMs).toISOString(),
      };
    }
  }
  return { balance, nextExpiry };
}

function denverOffsetMs(d: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: LOYALTY_TIMEZONE,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(d);
  const get = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  const wallAsUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour") % 24,
    get("minute"),
    get("second")
  );
  return wallAsUtc - Math.floor(d.getTime() / 1000) * 1000;
}

/** [start, end) UTC instants of the Denver calendar month holding `now`. */
export function loyaltyMonthWindow(now: Date): { start: Date; end: Date } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: LOYALTY_TIMEZONE,
    year: "numeric",
    month: "numeric",
  }).formatToParts(now);
  const year = Number(parts.find((p) => p.type === "year")!.value);
  const month = Number(parts.find((p) => p.type === "month")!.value); // 1–12
  const monthStartUtc = (y: number, m: number): Date => {
    let guess = Date.UTC(y, m - 1, 1, 0, 0, 0);
    for (let i = 0; i < 3; i++) {
      const corrected =
        Date.UTC(y, m - 1, 1, 0, 0, 0) - denverOffsetMs(new Date(guess));
      if (corrected === guess) break;
      guess = corrected;
    }
    return new Date(guess);
  };
  const start = monthStartUtc(year, month);
  const end =
    month === 12 ? monthStartUtc(year + 1, 1) : monthStartUtc(year, month + 1);
  return { start, end };
}

/** Paid spend in the current loyalty month (cancelled orders excluded). */
export async function getMonthSpentCents(
  userId: string,
  now = new Date()
): Promise<number> {
  const { start, end } = loyaltyMonthWindow(now);
  const supabase = getServiceClient();
  const { data, error } = await supabase
    .from("orders")
    .select("total_cents, kitchen_status")
    .eq("user_id", userId)
    .in("payment_status", ["paid", "test_paid"])
    .gte("created_at", start.toISOString())
    .lt("created_at", end.toISOString())
    .limit(10000);
  if (error) throw error;
  return (data ?? []).reduce(
    (sum, r) =>
      sum + (r.kitchen_status === "cancelled" ? 0 : (r.total_cents as number)),
    0
  );
}

/** The full loyalty picture for one customer (balance + unlock gate). */
export async function getPointsStatus(userId: string): Promise<PointsStatus> {
  const now = new Date();
  const [rows, monthSpentCents] = await Promise.all([
    loadLedger(userId),
    getMonthSpentCents(userId, now),
  ]);
  const { balance, nextExpiry } = spendableFromBuckets(
    computeBuckets(rows),
    now.getTime()
  );
  const unlocked = monthSpentCents >= UNLOCK_TARGET_CENTS;
  return {
    balance,
    monthSpentCents,
    unlockTargetCents: UNLOCK_TARGET_CENTS,
    unlocked,
    remainingToUnlockCents: Math.max(0, UNLOCK_TARGET_CENTS - monthSpentCents),
    nextExpiry,
  };
}

/** Spendable (unexpired) points — expiry-aware since 2026-11-23. */
export async function getPointsBalance(userId: string): Promise<number> {
  const rows = await loadLedger(userId);
  return spendableFromBuckets(computeBuckets(rows), Date.now()).balance;
}

/** How much of a balance can be applied to a subtotal, in whole blocks. */
export function redemptionFor(
  balance: number,
  subtotal_cents: number
): { blocks: number; points: number; discount_cents: number } {
  const blocks = Math.min(
    Math.floor(Math.max(balance, 0) / POINTS_PER_BLOCK),
    Math.floor(subtotal_cents / BLOCK_VALUE_CENTS)
  );
  return {
    blocks,
    points: blocks * POINTS_PER_BLOCK,
    discount_cents: blocks * BLOCK_VALUE_CENTS,
  };
}

async function insertLedgerRow(
  userId: string,
  orderId: number,
  delta: number,
  reason: "earn" | "redeem" | "refund" | "reversal"
): Promise<boolean> {
  const supabase = getServiceClient();
  const { error } = await supabase
    .from("points_ledger")
    .insert({ user_id: userId, order_id: orderId, delta, reason });
  if (error) {
    // 23505 = unique violation: this movement was already recorded.
    if ((error as { code?: string }).code === "23505") return false;
    throw error;
  }
  return true;
}

/** Called when an order becomes paid. Awards points to its account owner. */
export async function earnPointsForPaidOrder(order: {
  id: number;
  user_id?: string | null;
  total_cents: number;
}): Promise<void> {
  if (!order.user_id) return; // guests earn nothing
  const points = Math.floor(order.total_cents / 100);
  if (points <= 0) return;
  await insertLedgerRow(order.user_id, order.id, points, "earn");
}

/** Spends points at checkout. Caller must have validated the balance. */
export async function redeemPointsForOrder(
  userId: string,
  orderId: number,
  points: number
): Promise<void> {
  if (points <= 0) return;
  await insertLedgerRow(userId, orderId, -points, "redeem");
}

/**
 * On cancellation: refund any points the order redeemed, and reverse any
 * points it earned. Both idempotent.
 */
export async function reversePointsForCancelledOrder(orderId: number): Promise<void> {
  const supabase = getServiceClient();
  const { data: order } = await supabase
    .from("orders")
    .select("user_id, points_redeemed")
    .eq("id", orderId)
    .maybeSingle();
  if (!order?.user_id) return;
  const userId = order.user_id as string;

  if ((order.points_redeemed as number) > 0) {
    await insertLedgerRow(userId, orderId, order.points_redeemed as number, "refund");
  }
  const { data: earnRow } = await supabase
    .from("points_ledger")
    .select("delta")
    .eq("order_id", orderId)
    .eq("reason", "earn")
    .maybeSingle();
  if (earnRow && (earnRow.delta as number) > 0) {
    await insertLedgerRow(userId, orderId, -(earnRow.delta as number), "reversal");
  }
}

export interface PointsHistoryRow {
  id: number;
  order_id: number | null;
  delta: number;
  reason: string;
  created_at: string;
}

export async function getPointsHistory(
  userId: string,
  limit = 30
): Promise<PointsHistoryRow[]> {
  const supabase = getServiceClient();
  const { data, error } = await supabase
    .from("points_ledger")
    .select("id, order_id, delta, reason, created_at")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data as PointsHistoryRow[]) ?? [];
}
