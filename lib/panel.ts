// Operations admin panel data — server-side only (service-role client).
// Backs /api/admin/panel: Overview stats, the Orders browser, Reports,
// the Staff list and the Catalog editor (items with kitchen station,
// categories). Everything fails soft like the rest of the codebase: a
// missing table or column degrades to empty data / built-in defaults
// instead of an error page.

import { getServiceClient } from "./supabase/server";
import { denverParts } from "./hours";
import { adminStatusLabel, statusFilterStatuses } from "./kitchenStatus";
import { getDbMenu } from "./menuDb";
import { getDishPhotos, getUnavailableIds } from "./admin";
import type { OptionGroup } from "./menuOptions";
import type { OrderLine } from "./pricing";

export const PAID_STATUSES = ["paid", "test_paid"];
export const KITCHEN_STATUSES = [
  "new",
  "accepted",
  "preparing",
  "ready",
  "completed",
  "cancelled",
];

export interface PanelOrder {
  id: number;
  user_id: string | null;
  customer_name: string | null;
  customer_phone: string | null;
  items_json: OrderLine[];
  subtotal_cents: number;
  discount_cents: number;
  points_redeemed: number;
  tax_cents: number;
  delivery_fee_cents: number;
  tip_cents: number;
  total_cents: number;
  fulfillment: string;
  delivery_address: string | null;
  scheduled_for: string | null;
  payment_status: string;
  kitchen_status: string;
  shipday_status: string | null;
  /** Shipday's own order id — set when Shipday dispatched the order. */
  shipday_order_id?: string | null;
  created_at: string;
  // Stage 3 (DoorDash) — present once supabase/stage3-schema.sql has
  // run; undefined on a not-yet-migrated database.
  delivery_provider?: string | null;
  delivery_external_id?: string | null;
  delivery_status?: string | null;
  delivery_quote_id?: string | null;
  delivery_error?: string | null;
  delivery_status_at?: string | null;
  delivery_markup_cents?: number;
  // Service Fee + Free Delivery — present once
  // supabase/service-fee-promo-schema.sql has run.
  service_fee_cents?: number;
  free_delivery?: boolean;
  // Fresh KDS — present once supabase/freshkds-schema.sql has run.
  freshkds_status?: string | null;
  freshkds_error?: string | null;
  freshkds_sent_at?: string | null;
  // Curbside — present once supabase/curbside-schema.sql has run.
  car_description?: string | null;
  customer_here_at?: string | null;
  // Order note — present once supabase/order-note-schema.sql has run.
  note?: string | null;
  /** Joined from delivery_quotes (mode/fee/expiry) when available. */
  delivery_quote?: {
    provider_mode: string;
    fee_cents: number;
    expires_at: string;
  } | null;
}

/** Full order row minus Stripe's internal id (staff never need it). */
function toPanelOrder(row: Record<string, unknown>): PanelOrder {
  const copy = { ...row };
  delete copy.stripe_session_id;
  return copy as unknown as PanelOrder;
}

function isPaid(o: { payment_status: string }): boolean {
  return PAID_STATUSES.includes(o.payment_status);
}

/** Denver calendar day (YYYY-MM-DD) for a timestamp. */
function denverDay(iso: string): string {
  return denverParts(new Date(iso)).ymd;
}

// ---- Overview ---------------------------------------------------------------

export interface OverviewData {
  today: {
    date: string;
    orders: number;
    revenue_cents: number;
    avg_order_cents: number;
    by_status: Record<string, number>;
  };
  totals: { orders: number; revenue_cents: number; avg_order_cents: number };
  recent: PanelOrder[];
}

export async function getOverview(): Promise<OverviewData> {
  const empty: OverviewData = {
    today: {
      date: denverParts(new Date()).ymd,
      orders: 0,
      revenue_cents: 0,
      avg_order_cents: 0,
      by_status: {},
    },
    totals: { orders: 0, revenue_cents: 0, avg_order_cents: 0 },
    recent: [],
  };
  try {
    const supabase = getServiceClient();
    const todayYmd = denverParts(new Date()).ymd;
    // 48h window safely covers "today in Denver" whatever the server TZ is.
    const since = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
    const [recentRes, allRes] = await Promise.all([
      supabase
        .from("orders")
        .select("*")
        .gte("created_at", since)
        .order("created_at", { ascending: false })
        .limit(500),
      supabase.from("orders").select("payment_status, total_cents").limit(20000),
    ]);
    if (recentRes.error || allRes.error) return empty;
    const window = ((recentRes.data as Record<string, unknown>[]) ?? []).map(toPanelOrder);
    const todays = window.filter((o) => denverDay(o.created_at) === todayYmd);
    // One-tap flow: today's orders are counted by their DISPLAY status
    // (Accepted / Completed / Cancelled / New), so legacy in-progress
    // rows fold into "Accepted" instead of splintering the overview.
    const byStatus: Record<string, number> = {};
    for (const o of todays) {
      const label = adminStatusLabel(o);
      byStatus[label] = (byStatus[label] ?? 0) + 1;
    }
    const todayPaid = todays.filter(isPaid);
    const todayRevenue = todayPaid.reduce((s, o) => s + o.total_cents, 0);
    const all = (allRes.data as { payment_status: string; total_cents: number }[]) ?? [];
    const allPaid = all.filter(isPaid);
    const allRevenue = allPaid.reduce((s, o) => s + o.total_cents, 0);
    return {
      today: {
        date: todayYmd,
        orders: todays.length,
        revenue_cents: todayRevenue,
        avg_order_cents: todayPaid.length
          ? Math.round(todayRevenue / todayPaid.length)
          : 0,
        by_status: byStatus,
      },
      totals: {
        orders: all.length,
        revenue_cents: allRevenue,
        avg_order_cents: allPaid.length ? Math.round(allRevenue / allPaid.length) : 0,
      },
      recent: [...window]
        .sort((a, b) => b.created_at.localeCompare(a.created_at))
        .slice(0, 10),
    };
  } catch {
    return empty;
  }
}

// ---- Orders browser -----------------------------------------------------------

export interface OrderFilters {
  status?: string; // kitchen_status, or "all"
  payment?: string; // payment_status, or "all"
  q?: string; // customer name / phone / order id
  from?: string; // ISO date lower bound
  to?: string; // ISO date upper bound
  limit?: number;
}

export async function listPanelOrders(filters: OrderFilters): Promise<PanelOrder[]> {
  try {
    const supabase = getServiceClient();
    let query = supabase
      .from("orders")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(Math.min(Math.max(filters.limit ?? 200, 1), 500));
    if (filters.status && filters.status !== "all") {
      // One-tap flow filters: "accepted" matches every legacy
      // in-progress status; anything unrecognised falls back to an
      // exact match so the API stays tolerant of old callers.
      const mapped = statusFilterStatuses(filters.status);
      query = mapped
        ? query.in("kitchen_status", mapped)
        : query.eq("kitchen_status", filters.status);
    }
    if (filters.payment && filters.payment !== "all") {
      query = query.eq("payment_status", filters.payment);
    }
    if (filters.from) query = query.gte("created_at", filters.from);
    if (filters.to) query = query.lte("created_at", filters.to);
    const q = (filters.q ?? "").replace(/[,()%]/g, " ").trim();
    if (q) {
      const parts = [`customer_name.ilike.%${q}%`, `customer_phone.ilike.%${q}%`];
      if (/^\d+$/.test(q)) parts.push(`id.eq.${q}`);
      query = query.or(parts.join(","));
    }
    const { data, error } = await query;
    if (error) return [];
    const orders = ((data as Record<string, unknown>[]) ?? []).map(toPanelOrder);
    // Stage 3: attach each order's stored DoorDash quote (provider
    // mode, pure fee, expiry) for the detail pane's Delivery block.
    // Fails soft — no delivery_quotes table yet, no attachment.
    try {
      const quoteIds = [
        ...new Set(
          orders
            .map((o) => o.delivery_quote_id)
            .filter((v): v is string => typeof v === "string" && v.length > 0)
        ),
      ];
      if (quoteIds.length > 0) {
        const { data: quotes } = await supabase
          .from("delivery_quotes")
          .select("id, provider_mode, fee_cents, expires_at")
          .in("id", quoteIds);
        const byId = new Map(
          (quotes ?? []).map((q) => [
            q.id as string,
            {
              provider_mode: q.provider_mode as string,
              fee_cents: q.fee_cents as number,
              expires_at: q.expires_at as string,
            },
          ])
        );
        for (const o of orders) {
          o.delivery_quote = o.delivery_quote_id
            ? (byId.get(o.delivery_quote_id) ?? null)
            : null;
        }
      }
    } catch {
      /* quote join is decorative — never break the orders list */
    }
    return orders;
  } catch {
    return [];
  }
}

// ---- Reports (last 30 Denver days) -------------------------------------------

export interface ReportsData {
  days: { date: string; orders: number; revenue_cents: number }[];
  top_dishes: { name: string; qty: number; revenue_cents: number }[];
  totals: { orders: number; revenue_cents: number };
}

export async function getReports(): Promise<ReportsData> {
  const empty: ReportsData = { days: [], top_dishes: [], totals: { orders: 0, revenue_cents: 0 } };
  try {
    const supabase = getServiceClient();
    const since = new Date(Date.now() - 31 * 24 * 3600 * 1000).toISOString();
    const { data, error } = await supabase
      .from("orders")
      .select("*")
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(5000);
    if (error) return empty;
    const orders = ((data as Record<string, unknown>[]) ?? [])
      .map(toPanelOrder)
      .filter((o) => o.kitchen_status !== "cancelled");
    // The last 30 Denver days, oldest first, today last.
    const dayKeys: string[] = [];
    for (let i = 29; i >= 0; i--) {
      dayKeys.push(denverParts(new Date(Date.now() - i * 24 * 3600 * 1000)).ymd);
    }
    const byDay = new Map(dayKeys.map((d) => [d, { orders: 0, revenue_cents: 0 }]));
    const dishMap = new Map<string, { qty: number; revenue_cents: number }>();
    let totalOrders = 0;
    let totalRevenue = 0;
    for (const o of orders) {
      const day = byDay.get(denverDay(o.created_at));
      if (!day) continue; // outside the 30-day window (TZ edge)
      day.orders += 1;
      totalOrders += 1;
      if (isPaid(o)) {
        day.revenue_cents += o.total_cents;
        totalRevenue += o.total_cents;
      }
      for (const line of o.items_json ?? []) {
        const cur = dishMap.get(line.name) ?? { qty: 0, revenue_cents: 0 };
        cur.qty += line.qty || 0;
        cur.revenue_cents += line.line_total_cents || 0;
        dishMap.set(line.name, cur);
      }
    }
    return {
      days: dayKeys.map((date) => ({ date, ...(byDay.get(date) ?? { orders: 0, revenue_cents: 0 }) })),
      top_dishes: [...dishMap.entries()]
        .map(([name, v]) => ({ name, qty: v.qty, revenue_cents: v.revenue_cents }))
        .sort((a, b) => b.qty - a.qty || b.revenue_cents - a.revenue_cents)
        .slice(0, 10),
      totals: { orders: totalOrders, revenue_cents: totalRevenue },
    };
  } catch {
    return empty;
  }
}

// ---- Staff --------------------------------------------------------------------

export interface StaffPerson {
  id: string;
  email: string | null;
  role: string;
  display_name: string | null;
  phone: string | null;
  created_at: string;
  last_sign_in_at: string | null;
}

export async function listStaff(): Promise<{
  people: StaffPerson[];
  emails_available: boolean;
}> {
  try {
    const supabase = getServiceClient();
    const { data: profiles, error } = await supabase
      .from("profiles")
      .select("id, role, display_name, phone, created_at")
      .order("created_at", { ascending: true })
      .limit(1000);
    if (error) return { people: [], emails_available: false };
    // Join auth emails via the Supabase Auth admin API (service role).
    const emailById = new Map<string, { email: string | null; last: string | null }>();
    let emailsAvailable = true;
    try {
      const { data: users, error: usersError } = await supabase.auth.admin.listUsers({
        page: 1,
        perPage: 1000,
      });
      if (usersError) throw usersError;
      for (const u of users.users) {
        emailById.set(u.id, {
          email: u.email ?? null,
          last: u.last_sign_in_at ?? null,
        });
      }
    } catch {
      emailsAvailable = false;
    }
    const people = (profiles ?? []).map((p) => ({
      id: p.id as string,
      email: emailById.get(p.id as string)?.email ?? null,
      role: p.role as string,
      display_name: (p.display_name as string | null) ?? null,
      phone: (p.phone as string | null) ?? null,
      created_at: p.created_at as string,
      last_sign_in_at: emailById.get(p.id as string)?.last ?? null,
    }));
    // Staff first, then customers, each by sign-up date.
    people.sort((a, b) =>
      a.role === b.role
        ? a.created_at.localeCompare(b.created_at)
        : a.role === "staff"
          ? -1
          : 1
    );
    return { people, emails_available: emailsAvailable };
  } catch {
    return { people: [], emails_available: false };
  }
}

// ---- Catalog ------------------------------------------------------------------

export interface CatalogItem {
  id: string;
  number?: string;
  name: string;
  description: string;
  price_cents: number;
  category: string;
  image: string;
  station: string;
  /** Effective option groups (DB value, else the built-in fallback). */
  option_groups: OptionGroup[];
}

export interface CatalogData {
  from_db: boolean;
  categories: { name: string; dish_count: number }[];
  items: CatalogItem[];
  unavailable: string[];
  photos: Record<string, string>;
}

/** Station per dish id; empty when the column doesn't exist yet. */
async function getStations(): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  try {
    const supabase = getServiceClient();
    const { data, error } = await supabase.from("menu_items").select("id, station");
    if (error || !data) return map;
    for (const row of data) {
      const s = (row as { station?: unknown }).station;
      if (typeof s === "string" && s.trim()) map.set(row.id as string, s);
    }
  } catch {
    /* column missing — every dish defaults to "main" */
  }
  return map;
}

export async function getCatalog(): Promise<CatalogData> {
  const [menu, stations, unavailable, photos] = await Promise.all([
    getDbMenu(),
    getStations(),
    getUnavailableIds(),
    getDishPhotos(),
  ]);
  const counts = new Map<string, number>();
  for (const item of menu.items) {
    counts.set(item.category, (counts.get(item.category) ?? 0) + 1);
  }
  return {
    from_db: menu.fromDb,
    categories: menu.categories.map((name) => ({
      name,
      dish_count: counts.get(name) ?? 0,
    })),
    items: menu.items.map((i) => ({
      id: i.id,
      number: i.number,
      name: i.name,
      description: i.description,
      price_cents: i.price_cents,
      category: i.category,
      image: i.image,
      station: stations.get(i.id) ?? "main",
      option_groups: i.option_groups ?? [],
    })),
    unavailable: [...unavailable],
    photos,
  };
}

export interface MenuItemEdit {
  name: string;
  number: string | null;
  category: string;
  price_cents: number;
  description: string;
  station: string;
  /**
   * Validated option groups to store with the dish. Undefined leaves
   * the stored groups untouched; an empty array means "no options"
   * (the storefront honours an explicitly empty list — see
   * sanitizeOptionGroups).
   */
  option_groups?: OptionGroup[];
}

/** True when a PostgREST error is about the not-yet-added station column. */
function stationColumnMissing(error: { message?: string } | null): boolean {
  return Boolean(error?.message && /station/i.test(error.message));
}

export async function updateMenuItem(id: string, edit: MenuItemEdit): Promise<void> {
  const supabase = getServiceClient();
  const base = {
    name: edit.name,
    number: edit.number,
    category: edit.category,
    price_cents: edit.price_cents,
    description: edit.description,
  };
  // Option groups ride along only when the editor sent them; the
  // station fallback below drops ONLY the station, never the options.
  const extras: { option_groups?: OptionGroup[] } = {};
  if (edit.option_groups !== undefined) extras.option_groups = edit.option_groups;
  let res = await supabase
    .from("menu_items")
    .update({ ...base, station: edit.station || "main", ...extras })
    .eq("id", id)
    .select("id");
  if (res.error && stationColumnMissing(res.error)) {
    // Migration not run yet — save everything except the station.
    res = await supabase
      .from("menu_items")
      .update({ ...base, ...extras })
      .eq("id", id)
      .select("id");
  }
  if (res.error) throw res.error;
  if (!res.data || res.data.length === 0) {
    throw new Error(
      "This dish is not in the database menu yet — run supabase/admin-schema.sql in Supabase to seed it, then edit here."
    );
  }
}

export async function deleteMenuItem(id: string): Promise<void> {
  const supabase = getServiceClient();
  const { data, error } = await supabase
    .from("menu_items")
    .delete()
    .eq("id", id)
    .select("id");
  if (error) throw error;
  if (!data || data.length === 0) {
    throw new Error(
      "This dish is not in the database menu yet — run supabase/admin-schema.sql in Supabase to seed it, then delete here."
    );
  }
  // Availability / photo rows for a dish that no longer exists are clutter.
  await supabase.from("dish_availability").delete().eq("item_id", id);
  await supabase.from("dish_photos").delete().eq("item_id", id);
}

export async function renameCategory(from: string, to: string): Promise<void> {
  if (from === to) return;
  const supabase = getServiceClient();
  const { data: existing } = await supabase
    .from("menu_categories")
    .select("name")
    .eq("name", to)
    .maybeSingle();
  if (existing) throw new Error(`A category named "${to}" already exists.`);
  const { error: catError } = await supabase
    .from("menu_categories")
    .update({ name: to })
    .eq("name", from);
  if (catError) throw catError;
  const { error: itemError } = await supabase
    .from("menu_items")
    .update({ category: to })
    .eq("category", from);
  if (itemError) throw itemError;
}
