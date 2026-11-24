// /api/admin — admin-controlled site state.
// GET  (no login): public view — settings, sold-out dish ids, ACTIVE
//      promotions. The storefront reads this on load.
// GET  (staff token): full view — also inactive promotions.
// POST (staff token only): actions —
//      { action: "set_setting", key, value }
//      { action: "set_availability", item_id, available }
//      { action: "promo_create", title, body }
//      { action: "promo_set_active", id, active }
//      { action: "promo_delete", id }
// POST returns the refreshed full state.

import { NextResponse } from "next/server";
import { supabaseConfigured, verifyKitchenUser } from "@/lib/supabase/server";
import {
  getSettings,
  setSetting,
  isSettingKey,
  getUnavailableIds,
  setDishAvailability,
  listPromotions,
  createPromotion,
  setPromotionActive,
  deletePromotion,
  getDishPhotos,
  uploadDishPhoto,
  deleteDishPhoto,
  HERO_PHOTO_ID,
  HERO_VIDEO_ID,
  addCategory,
  addMenuItem,
  getHoursConfig,
  setHoursConfig,
} from "@/lib/admin";
import { HOURS_SETTING_KEYS, parseHHMM } from "@/lib/hours";
import { getMenuItem } from "@/lib/menu";
import { getDbMenu } from "@/lib/menuDb";
import { logAudit } from "@/lib/audit";
import { getDeliverySettings, setDeliverySettings } from "@/lib/delivery";
import { parseHouseTiers } from "@/lib/deliveryPricing";
import {
  getFeeSettings,
  setFreeDeliverySettings,
  setServiceFeeSettings,
} from "@/lib/fees";
import {
  generatePairingCode,
  getPrinterAdminView,
  queueTestPrint,
  requestRescan,
  revokeBridge,
  selectPrinter,
  setPrinterCopies,
  setPrinterEnabled,
} from "@/lib/printer";
import { getFreshKdsEnabled, setFreshKdsEnabled } from "@/lib/freshkds";

export const dynamic = "force-dynamic";

async function staffState() {
  const [
    settings,
    unavailable,
    promotions,
    photos,
    menu,
    hours,
    delivery,
    fees,
    printer,
    freshkdsEnabled,
  ] = await Promise.all([
    getSettings(),
    getUnavailableIds(),
    listPromotions(false),
    getDishPhotos(),
    getDbMenu(),
    getHoursConfig(),
    getDeliverySettings(),
    getFeeSettings(),
    getPrinterAdminView(),
    getFreshKdsEnabled(),
  ]);
  return {
    settings,
    unavailable: [...unavailable],
    promotions,
    photos,
    hours,
    // Stage 3 delivery settings + provider switch (staff view only —
    // the public GET below carries only the provider + Shipday fee
    // inside its settings object; the top-level shape is unchanged).
    delivery: {
      max_miles: delivery.max_miles,
      min_subtotal_cents: delivery.min_subtotal_cents,
      markup_flat_cents: delivery.markup_flat_cents,
      markup_percent: delivery.markup_percent,
      provider: delivery.provider,
      shipday_fee_cents: delivery.shipday_fee_cents,
      // House Delivery update: the three switches + radius tiers.
      doordash_enabled: delivery.doordash_enabled,
      shipday_enabled: delivery.shipday_enabled,
      house_enabled: delivery.house_enabled,
      house_tiers: delivery.house_tiers,
    },
    // Service Fee + Free Delivery settings (staff view only, same
    // reasoning as the delivery settings above).
    fees: {
      service_fee: fees.service_fee,
      free_delivery: fees.free_delivery,
    },
    // Kitchen printer / print bridge (staff view only — the bridge
    // token hash and pairing internals never leave lib/printer.ts;
    // this view carries no secrets). `enabled` inside it is the
    // print ON/OFF switch.
    printer,
    // Fresh KDS ON/OFF switch (staff view only, same reasoning).
    freshkds_enabled: freshkdsEnabled,
    menu: { categories: menu.categories, items: menu.items },
  };
}

export async function GET(req: Request) {
  const [settings, unavailable, activePromos, photos, hours, deliverySettings] =
    await Promise.all([
      getSettings(),
      getUnavailableIds(),
      listPromotions(true),
      getDishPhotos(),
      getHoursConfig(),
      // Provider switch: the storefront needs to know the active
      // delivery provider + the Shipday flat fee BEFORE checkout.
      // getDeliverySettings is fail-soft (DoorDash + $6.99 defaults),
      // so this can never break the public GET.
      getDeliverySettings(),
    ]);
  const publicState = {
    // The public shape stays EXACTLY the five top-level keys — the
    // provider + Shipday fee ride INSIDE the settings object.
    settings: {
      ...settings,
      delivery_provider: deliverySettings.provider,
      shipday_delivery_fee_cents: deliverySettings.shipday_fee_cents,
      // House Delivery update: the storefront resolves flat-fee
      // (no-quote) mode from the three switches — Shipday flat fee
      // applies only when Shipday is the ONLY provider enabled.
      delivery_doordash_enabled: deliverySettings.doordash_enabled,
      delivery_shipday_enabled: deliverySettings.shipday_enabled,
      delivery_house_enabled: deliverySettings.house_enabled,
    },
    hours,
    unavailable: [...unavailable],
    promotions: activePromos.map((p) => ({
      id: p.id,
      title: p.title,
      body: p.body,
      item_id: p.item_id ?? null,
    })),
    photos,
  };
  // A valid staff token upgrades the response to the full admin view.
  if (supabaseConfigured()) {
    const user = await verifyKitchenUser(req).catch(() => null);
    if (user) {
      const full = await staffState();
      return NextResponse.json({ ...full, staff: true });
    }
  }
  return NextResponse.json(publicState);
}

export async function POST(req: Request) {
  if (!supabaseConfigured()) {
    return NextResponse.json({ error: "Database is not configured." }, { status: 503 });
  }
  const user = await verifyKitchenUser(req);
  if (!user) {
    return NextResponse.json({ error: "Staff login required." }, { status: 401 });
  }
  // Dish photo upload arrives as multipart form data.
  const contentType = req.headers.get("content-type") ?? "";
  if (contentType.includes("multipart/form-data")) {
    try {
      const form = await req.formData();
      const itemId = String(form.get("item_id") ?? "");
      const file = form.get("file");
      if (!itemId || !(file instanceof File)) {
        return NextResponse.json({ error: "Missing dish or file." }, { status: 400 });
      }
      // The reserved hero-video id takes a video file; every other id
      // (dishes and the hero photo) takes an image.
      if (itemId === HERO_VIDEO_ID) {
        if (!["video/mp4", "video/webm"].includes(file.type)) {
          return NextResponse.json(
            { error: "Please choose an MP4 or WebM video." },
            { status: 400 }
          );
        }
        if (file.size > 15 * 1024 * 1024) {
          return NextResponse.json({ error: "Video is too large (max 15 MB)." }, { status: 400 });
        }
      } else {
        if (!["image/jpeg", "image/png", "image/webp", "image/gif"].includes(file.type)) {
          return NextResponse.json(
            { error: "Please choose a JPG, PNG, WebP or GIF image." },
            { status: 400 }
          );
        }
        if (file.size > 5 * 1024 * 1024) {
          return NextResponse.json({ error: "Image is too large (max 5 MB)." }, { status: 400 });
        }
      }
      await uploadDishPhoto(itemId, await file.arrayBuffer(), file.type);
      await logAudit(user.email ?? user.id, "admin.photo_upload", { item_id: itemId });
    } catch (err) {
      console.error("[admin] photo upload failed:", err);
      return NextResponse.json({ error: "Photo upload failed." }, { status: 500 });
    }
    const full = await staffState();
    return NextResponse.json({ ...full, staff: true });
  }
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }
  const actor = user.email ?? user.id;
  try {
    switch (body.action) {
      case "set_setting": {
        const key = String(body.key ?? "");
        if (!isSettingKey(key)) throw new Error("Unknown setting");
        await setSetting(key, body.value === true);
        await logAudit(actor, "admin.set_setting", { key, value: body.value === true });
        break;
      }
      case "set_hours": {
        const raw =
          body.hours && typeof body.hours === "object"
            ? (body.hours as Record<string, unknown>)
            : {};
        const values: Record<string, string> = {};
        for (const key of HOURS_SETTING_KEYS) {
          if (parseHHMM(raw[key]) === null) {
            throw new Error("Please fill in all eight opening and closing times.");
          }
          values[key] = String(raw[key]).trim();
        }
        const pairs: [string, string, string][] = [
          ["hours_pickup_mon_sat_open", "hours_pickup_mon_sat_close", "Pickup (Mon–Sat)"],
          ["hours_pickup_sun_open", "hours_pickup_sun_close", "Pickup (Sunday)"],
          ["hours_delivery_mon_sat_open", "hours_delivery_mon_sat_close", "Delivery (Mon–Sat)"],
          ["hours_delivery_sun_open", "hours_delivery_sun_close", "Delivery (Sunday)"],
        ];
        for (const [openKey, closeKey, label] of pairs) {
          if ((parseHHMM(values[openKey]) ?? 0) >= (parseHHMM(values[closeKey]) ?? 0)) {
            throw new Error(`${label}: closing time must be after opening time.`);
          }
        }
        await setHoursConfig(values);
        await logAudit(actor, "admin.set_hours", { ...values });
        break;
      }
      case "set_delivery_settings": {
        // Stage 3: DoorDash delivery radius cap, delivery minimum,
        // and the extra delivery markup (flat + percent). Provider
        // switch: provider + shipday_delivery_fee_cents are OPTIONAL
        // in the payload — when absent they keep their current values
        // (older panels never reset the switch by accident).
        const max_miles = Number(body.max_miles);
        const min_subtotal_cents = Math.floor(Number(body.min_subtotal_cents));
        const markup_flat_cents = Math.floor(Number(body.markup_flat_cents));
        const markup_percent = Number(body.markup_percent);
        if (!Number.isFinite(max_miles) || max_miles < 1 || max_miles > 15) {
          throw new Error("Delivery radius must be between 1 and 15 miles.");
        }
        if (!Number.isFinite(min_subtotal_cents) || min_subtotal_cents < 0 || min_subtotal_cents > 100000) {
          throw new Error("Enter a valid delivery minimum (or 0 for off).");
        }
        if (!Number.isFinite(markup_flat_cents) || markup_flat_cents < 0 || markup_flat_cents > 10000) {
          throw new Error("Enter a valid flat service fee (or 0 for off).");
        }
        if (!Number.isFinite(markup_percent) || markup_percent < 0 || markup_percent > 100) {
          throw new Error("Service-fee percent must be between 0 and 100.");
        }
        const currentDelivery = await getDeliverySettings();
        const provider =
          body.provider === "shipday"
            ? "shipday"
            : body.provider === "doordash"
              ? "doordash"
              : currentDelivery.provider;
        const shipday_fee_cents =
          body.shipday_delivery_fee_cents === undefined
            ? currentDelivery.shipday_fee_cents
            : Math.floor(Number(body.shipday_delivery_fee_cents));
        if (
          !Number.isFinite(shipday_fee_cents) ||
          shipday_fee_cents < 0 ||
          shipday_fee_cents > 100000
        ) {
          throw new Error("Enter a valid Shipday delivery fee (or 0 for free).");
        }
        // House Delivery update: the three ON/OFF switches + the
        // radius tiers are OPTIONAL in the payload — when absent
        // they keep their current values (older panels never reset
        // them by accident).
        const doordash_enabled =
          body.doordash_enabled === undefined
            ? currentDelivery.doordash_enabled
            : body.doordash_enabled === true;
        const shipday_enabled =
          body.shipday_enabled === undefined
            ? currentDelivery.shipday_enabled
            : body.shipday_enabled === true;
        const house_enabled =
          body.house_enabled === undefined
            ? currentDelivery.house_enabled
            : body.house_enabled === true;
        const house_tiers =
          body.house_tiers === undefined
            ? currentDelivery.house_tiers
            : parseHouseTiers(body.house_tiers);
        await setDeliverySettings({
          max_miles,
          min_subtotal_cents,
          markup_flat_cents,
          markup_percent,
          provider,
          shipday_fee_cents,
          doordash_enabled,
          shipday_enabled,
          house_enabled,
          house_tiers,
        });
        await logAudit(actor, "admin.set_delivery_settings", {
          max_miles,
          min_subtotal_cents,
          markup_flat_cents,
          markup_percent,
          provider,
          shipday_fee_cents,
          doordash_enabled,
          shipday_enabled,
          house_enabled,
          house_tiers,
        });
        break;
      }
      case "set_service_fee": {
        // General Service Fee (Operations): on/off + percent-of-subtotal
        // OR flat per order. Applies to every order; never taxed.
        const enabled = body.enabled === true;
        const type = body.type === "flat" ? "flat" : "percent";
        const percent = Number(body.percent);
        const flat_cents = Math.floor(Number(body.flat_cents));
        if (!Number.isFinite(percent) || percent < 0 || percent > 100) {
          throw new Error("Service-fee percent must be between 0 and 100.");
        }
        if (!Number.isFinite(flat_cents) || flat_cents < 0 || flat_cents > 100000) {
          throw new Error("Enter a valid flat service fee (or 0 for off).");
        }
        await setServiceFeeSettings({ enabled, type, percent, flat_cents });
        await logAudit(actor, "admin.set_service_fee", { enabled, type, percent, flat_cents });
        break;
      }
      case "set_free_delivery": {
        // Free Delivery promotion (Promotions section): on/off +
        // the food-subtotal amount at/above which delivery is $0.
        const enabled = body.enabled === true;
        const threshold_cents = Math.floor(Number(body.threshold_cents));
        if (!Number.isFinite(threshold_cents) || threshold_cents < 0 || threshold_cents > 1000000) {
          throw new Error("Enter a valid free-delivery amount (in dollars).");
        }
        if (enabled && threshold_cents <= 0) {
          throw new Error("Set the order amount for free delivery (e.g. $50).");
        }
        await setFreeDeliverySettings({ enabled, threshold_cents });
        await logAudit(actor, "admin.set_free_delivery", { enabled, threshold_cents });
        break;
      }
      case "printer_generate_code": {
        // Opens a 15-minute pairing window for the print bridge. The
        // code itself is shown by the card (it reads it back from the
        // staff state); the audit log records only that one was made.
        const { expires_at } = await generatePairingCode();
        await logAudit(actor, "printer.pairing_code", { expires_at });
        break;
      }
      case "printer_revoke": {
        // Revoke / re-pair: invalidates the bridge token and clears
        // the bridge state. The bridge must pair again with a new code.
        await revokeBridge();
        await logAudit(actor, "printer.pairing_reset", {});
        break;
      }
      case "printer_select": {
        const name = String(body.printer ?? "").trim().slice(0, 120);
        await selectPrinter(name || null);
        await logAudit(actor, "printer.select", { printer: name || null });
        break;
      }
      case "printer_rescan": {
        await requestRescan();
        await logAudit(actor, "printer.rescan", {});
        break;
      }
      case "printer_set_copies": {
        const copies = Math.floor(Number(body.copies));
        if (!Number.isFinite(copies) || copies < 1 || copies > 3) {
          throw new Error("Copies must be 1, 2 or 3.");
        }
        await setPrinterCopies(copies);
        await logAudit(actor, "printer.set_copies", { copies });
        break;
      }
      case "printer_test_print": {
        await queueTestPrint();
        await logAudit(actor, "printer.test_print", {});
        break;
      }
      case "printer_set_enabled": {
        // Print ON/OFF switch. OFF stops the bridge jobs feed handing
        // out order tickets (test tickets still flow); ON advances
        // the print cutoff so orders paid while OFF are skipped.
        const enabled = body.enabled === true;
        await setPrinterEnabled(enabled);
        await logAudit(actor, "printer.set_enabled", { enabled });
        break;
      }
      case "freshkds_set_enabled": {
        // Fresh KDS ON/OFF switch (website orders only — Square /
        // kiosk orders reach the screens through Square itself).
        const enabled = body.enabled === true;
        await setFreshKdsEnabled(enabled);
        await logAudit(actor, "freshkds.set_enabled", { enabled });
        break;
      }
      case "set_availability": {
        const itemId = String(body.item_id ?? "");
        const menu = await getDbMenu();
        if (!menu.items.some((i) => i.id === itemId) && !getMenuItem(itemId)) {
          throw new Error("Unknown dish");
        }
        await setDishAvailability(itemId, body.available === true);
        await logAudit(actor, "admin.set_availability", {
          item_id: itemId,
          available: body.available === true,
        });
        break;
      }
      case "photo_delete": {
        const itemId = String(body.item_id ?? "");
        // The reserved hero ids are not menu dishes but are explicitly
        // allowed; any other id must be a real dish.
        if (itemId !== HERO_PHOTO_ID && itemId !== HERO_VIDEO_ID) {
          const menu = await getDbMenu();
          if (!menu.items.some((i) => i.id === itemId) && !getMenuItem(itemId)) {
            throw new Error("Unknown dish");
          }
        }
        await deleteDishPhoto(itemId);
        await logAudit(actor, "admin.photo_delete", { item_id: itemId });
        break;
      }
      case "promo_create": {
        const title = String(body.title ?? "").trim().slice(0, 120);
        const text = String(body.body ?? "").trim().slice(0, 400);
        const itemId = String(body.item_id ?? "").trim();
        if (!title) throw new Error("A promotion needs a title");
        if (itemId) {
          const menu = await getDbMenu();
          if (!menu.items.some((i) => i.id === itemId)) {
            throw new Error("Unknown dish for the promotion");
          }
        }
        await createPromotion(title, text, itemId || null);
        await logAudit(actor, "admin.promo_create", { title, item_id: itemId || null });
        break;
      }
      case "promo_set_active": {
        await setPromotionActive(Math.floor(Number(body.id)), body.active === true);
        await logAudit(actor, "admin.promo_set_active", {
          id: Math.floor(Number(body.id)),
          active: body.active === true,
        });
        break;
      }
      case "promo_delete": {
        await deletePromotion(Math.floor(Number(body.id)));
        await logAudit(actor, "admin.promo_delete", { id: Math.floor(Number(body.id)) });
        break;
      }
      case "add_category": {
        const name = String(body.name ?? "").trim().slice(0, 60);
        if (!name) throw new Error("A category needs a name");
        await addCategory(name);
        await logAudit(actor, "admin.add_category", { name });
        break;
      }
      case "add_item": {
        const name = String(body.name ?? "").trim().slice(0, 80);
        const description = String(body.description ?? "").trim().slice(0, 300);
        const price_cents = Math.floor(Number(body.price_cents));
        const category = String(body.category ?? "").trim().slice(0, 60);
        const number = String(body.number ?? "").trim().slice(0, 10);
        const station = String(body.station ?? "").trim().slice(0, 40);
        if (!name) throw new Error("A dish needs a name");
        if (!category) throw new Error("Choose a category");
        if (!Number.isFinite(price_cents) || price_cents < 1 || price_cents > 100000) {
          throw new Error("Enter a valid price");
        }
        const newId = await addMenuItem({
          name,
          description,
          price_cents,
          category,
          number,
          station: station || undefined,
        });
        await logAudit(actor, "admin.add_item", {
          id: newId,
          name,
          category,
          price_cents,
          station: station || "main",
        });
        break;
      }
      default:
        return NextResponse.json({ error: "Unknown action" }, { status: 400 });
    }
  } catch (err) {
    console.error("[admin] action failed:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Action failed" },
      { status: 400 }
    );
  }
  const full = await staffState();
  return NextResponse.json({ ...full, staff: true });
}
