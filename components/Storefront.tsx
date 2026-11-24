"use client";

// Madinah Market menu page: category sidebar + search, dish
// grid, per-dish options popup, cart (localStorage), pickup/delivery
// toggle, live delivery-fee quote, tip selector, live price breakdown
// and the two-step checkout. The server recomputes every total — the
// numbers here are only for display.

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import Link from "next/link";
import { formatCents, type MenuItem, type SelectedOption } from "@/lib/menu";
import { getBrowserClient } from "@/lib/supabase/client";
import {
  CART_EVENT,
  loadCart,
  saveCart,
  clearCart,
  lineKey,
  type CartLine,
} from "@/lib/cartClient";
import DishPopup from "./DishPopup";
import CurbsideHere from "./CurbsideHere";
import { checkoutOffersCurbside, type Fulfillment } from "@/lib/fulfillment";
import {
  computeServiceFeeCents,
  DEFAULT_FREE_DELIVERY,
  DEFAULT_SERVICE_FEE,
  freeDeliveryApplies,
  type FreeDeliveryConfig,
  type ServiceFeeConfig,
} from "@/lib/feePricing";
import {
  PICKUP_HOURS,
  DELIVERY_HOURS,
  DEFAULT_HOURS_CONFIG,
  pickupWindows,
  deliveryWindows,
  formatWindow,
  pickupWindowToday,
  denverParts,
  denverTimeTodayToISO,
  validatePickupTime,
  minutesToInputValue,
  type HoursConfig,
} from "@/lib/hours";

type FeeState =
  | { kind: "idle" }
  | { kind: "loading" }
  | {
      kind: "ok";
      quote_id: string;
      /** Pure DoorDash fee. */
      fee_cents: number;
      /** Restaurant's extra delivery markup, if any. */
      service_fee_cents: number;
      /** The ONE delivery amount the customer pays (fee + markup merged). */
      delivery_charge_cents: number;
      /** True when the Free Delivery promotion zeroed the charge. */
      free_delivery: boolean;
      label: string;
      expires_at: string;
    }
  | { kind: "far"; message: string }
  | { kind: "not_found" }
  | { kind: "error"; message: string }
  | { kind: "expired" };

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: string }>;
}

function taxFor(subtotal: number): number {
  return Math.round(subtotal * 0.08);
}

interface SiteState {
  settings: {
    ordering_enabled: boolean;
    pickup_enabled: boolean;
    delivery_enabled: boolean;
    /** Absent in older payloads = curbside ON (it ships enabled). */
    curbside_enabled?: boolean;
    /**
     * Active delivery provider (provider switch), riding inside the
     * public settings object. Absent in older payloads = DoorDash.
     */
    delivery_provider?: string;
    /** Flat delivery fee in cents when the provider is Shipday. */
    shipday_delivery_fee_cents?: number;
    /**
     * House Delivery update: the three provider switches. Absent in
     * older payloads — then the legacy delivery_provider decides.
     */
    delivery_doordash_enabled?: boolean;
    delivery_shipday_enabled?: boolean;
    delivery_house_enabled?: boolean;
  };
  unavailable: string[];
  promotions: { id: number; title: string; body: string; item_id: string | null }[];
  photos: Record<string, string>;
  hours?: HoursConfig;
}

interface DisplayLine {
  key: string;
  cartLine: CartLine;
  item: MenuItem;
  qty: number;
  unit_cents: number;
  line_total_cents: number;
}

export default function Storefront({
  testMode,
  menu,
  categories,
  fees,
}: {
  testMode: boolean;
  menu: MenuItem[];
  categories: string[];
  /** Service Fee / Free Delivery settings, read server-side (the
   * checkout server recomputes everything — display only). */
  fees?: { service_fee: ServiceFeeConfig; free_delivery: FreeDeliveryConfig };
}) {
  const [cart, setCart] = useState<CartLine[]>([]);
  const [cartLoaded, setCartLoaded] = useState(false);
  const [popupItem, setPopupItem] = useState<MenuItem | null>(null);
  const [activeCat, setActiveCat] = useState<string>("All");
  const [query, setQuery] = useState("");
  const [showCheckout, setShowCheckout] = useState(false);
  // Two-step checkout (after the sign-in/guest gate): 1 = details form,
  // 2 = review + the single "Place order — $total" button.
  const [checkoutStep, setCheckoutStep] = useState<0 | 1 | 2>(0);
  const [fulfillment, setFulfillment] = useState<Fulfillment>("pickup");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [phone, setPhone] = useState("");
  const [address, setAddress] = useState("");
  const [car, setCar] = useState("");
  const [note, setNote] = useState("");
  const [fee, setFee] = useState<FeeState>({ kind: "idle" });
  const [quoteNonce, setQuoteNonce] = useState(0);
  const [tipPercent, setTipPercent] = useState(0);
  const [tipCustom, setTipCustom] = useState("");
  const [error, setError] = useState("");
  const [placing, setPlacing] = useState(false);
  const [successOrder, setSuccessOrder] = useState<number | null>(null);
  // The just-placed order's fulfillment + phone (kept in sessionStorage
  // across the Stripe redirect) — drives the curbside "I'm here" button
  // on the confirmation banner.
  const [lastOrder, setLastOrder] = useState<{
    id: number;
    fulfillment: Fulfillment;
    phone: string;
    car: string;
  } | null>(null);
  const [qrSource, setQrSource] = useState(false);
  const [installEvent, setInstallEvent] = useState<BeforeInstallPromptEvent | null>(null);
  const [accountName, setAccountName] = useState<string | null>(null);
  const [accountEmail, setAccountEmail] = useState<string | null>(null);
  const [guestChosen, setGuestChosen] = useState(false);
  const [siOpen, setSiOpen] = useState(false);
  const [siEmail, setSiEmail] = useState("");
  const [siPassword, setSiPassword] = useState("");
  const [siBusy, setSiBusy] = useState(false);
  const [siError, setSiError] = useState("");
  // Loyalty (signed-in customers only).
  const [pointsBalance, setPointsBalance] = useState<number | null>(null);
  const [usePoints, setUsePoints] = useState(false);
  // The $100-a-month unlock gate (rules: lib/points.ts). Null until
  // /api/account/me answers; the server re-checks at checkout anyway.
  const [pointsGate, setPointsGate] = useState<{
    unlocked: boolean;
    monthSpentCents: number;
    remainingToUnlockCents: number;
  } | null>(null);
  // Admin-controlled site state (switches, sold-out dishes, promotions,
  // uploaded photos). Defaults keep the site fully open until loaded.
  const [siteState, setSiteState] = useState<SiteState | null>(null);
  // Scheduled pickup.
  const [pickupWhen, setPickupWhen] = useState<"asap" | "later">("asap");
  const [pickupTime, setPickupTime] = useState("");
  const feeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const feeSeq = useRef(0);

  // Load cart + URL state once on mount.
  useEffect(() => {
    setCart(loadCart());
    setCartLoaded(true);
    const params = new URLSearchParams(window.location.search);
    if (params.get("source") === "qr") setQrSource(true);
    const orderParam = Number(params.get("order"));
    if (orderParam && params.get("paid") === "1") {
      setSuccessOrder(orderParam);
      setCart([]);
      clearCart();
      // Returning from Stripe: recover the just-placed order's details
      // (saved by placeOrder before the redirect) for the curbside
      // "I'm here" button on the confirmation banner.
      try {
        const raw = sessionStorage.getItem("mm_last_order");
        if (raw) {
          const saved = JSON.parse(raw) as {
            id?: number;
            fulfillment?: Fulfillment;
            phone?: string;
            car?: string;
          };
          if (saved.id === orderParam && saved.fulfillment && saved.phone) {
            setLastOrder({
              id: orderParam,
              fulfillment: saved.fulfillment,
              phone: saved.phone,
              car: saved.car ?? "",
            });
          }
        }
      } catch {
        /* the banner simply shows without the button */
      }
    }
    const onInstall = (e: Event) => {
      e.preventDefault();
      setInstallEvent(e as BeforeInstallPromptEvent);
    };
    window.addEventListener("beforeinstallprompt", onInstall);
    return () => window.removeEventListener("beforeinstallprompt", onInstall);
  }, []);

  useEffect(() => {
    if (cartLoaded) saveCart(cart);
  }, [cart, cartLoaded]);

  // A fresh checkout always starts on step 1 (details) — never on the
  // review step of a previous, closed checkout.
  useEffect(() => {
    if (!showCheckout) setCheckoutStep(0);
  }, [showCheckout]);

  // The checkout screens scroll inside their own middle area (the bar
  // is built into the screen) — every screen change starts at the top.
  const checkoutScrollRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    checkoutScrollRef.current?.scrollTo({ top: 0 });
  }, [checkoutStep, showCheckout]);

  // The checkout sheet is a fixed screen that must start exactly
  // where the header ends and fill the rest of the window. Measure
  // both in real pixels (no guessed offsets): park the header at the
  // top, read its bottom edge, size the sheet to the window, and lock
  // the page behind it. Closing restores the page as it was.
  const [sheetBox, setSheetBox] = useState<{
    top: number;
    height: number;
  } | null>(null);
  useEffect(() => {
    if (!showCheckout) return;
    const header = document.querySelector<HTMLElement>(".site-header");
    const measure = () => {
      const bottom = header
        ? Math.round(header.getBoundingClientRect().bottom)
        : 88;
      setSheetBox({
        top: bottom,
        height: Math.max(240, window.innerHeight - bottom),
      });
    };
    const prevScroll = window.scrollY;
    const prevOverflow = document.body.style.overflow;
    window.scrollTo(0, document.documentElement.scrollHeight);
    measure();
    document.body.style.overflow = "hidden";
    window.addEventListener("resize", measure);
    return () => {
      document.body.style.overflow = prevOverflow;
      window.removeEventListener("resize", measure);
      window.scrollTo(0, prevScroll);
    };
  }, [showCheckout]);

  // The header bag button (TopNav) asks us to open the checkout panel —
  // the same thing the bottom bar's "Checkout →" does.
  const openCheckoutRef = useRef<() => void>(() => {});
  useEffect(() => {
    openCheckoutRef.current = () => {
      if (lines.length === 0) return;
      setShowCheckout(true);
      setTimeout(
        () =>
          document
            .getElementById("checkout")
            ?.scrollIntoView({ behavior: "smooth" }),
        50
      );
    };
  });
  useEffect(() => {
    const handler = () => openCheckoutRef.current();
    window.addEventListener("mm:open-checkout", handler);
    return () => window.removeEventListener("mm:open-checkout", handler);
  }, []);

  // Admin-controlled site state: switches, sold-out dishes, promotions,
  // uploaded dish photos. Loaded once; the site fails open (all ordering
  // on, everything available) if it cannot be reached.
  useEffect(() => {
    fetch("/api/admin")
      .then((r) => (r.ok ? r.json() : null))
      .then((data: SiteState | null) => {
        if (data) setSiteState(data);
      })
      .catch(() => {});
  }, []);

  const orderingClosed = siteState !== null && !siteState.settings.ordering_enabled;
  const pickupOff = siteState !== null && !siteState.settings.pickup_enabled;
  const deliveryOff = siteState !== null && !siteState.settings.delivery_enabled;
  const curbsideOff =
    siteState !== null && !checkoutOffersCurbside(siteState.settings);
  const unavailableSet = new Set(siteState?.unavailable ?? []);
  const promos = siteState?.promotions ?? [];
  const dishPhotos = siteState?.photos ?? {};
  // Admin-editable hours (fall back to the built-in defaults until the
  // site state loads or if the server does not send them).
  const hoursCfg = siteState?.hours ?? DEFAULT_HOURS_CONFIG;
  const pickupWins = siteState?.hours ? pickupWindows(hoursCfg) : PICKUP_HOURS;
  const deliveryWins = siteState?.hours ? deliveryWindows(hoursCfg) : DELIVERY_HOURS;

  // If the admin turned the selected fulfillment type off, switch over.
  useEffect(() => {
    if (fulfillment === "pickup" && pickupOff && !deliveryOff) setFulfillment("delivery");
    if (fulfillment === "delivery" && deliveryOff && !pickupOff) setFulfillment("pickup");
    if (fulfillment === "curbside" && curbsideOff) {
      setFulfillment(!pickupOff ? "pickup" : "delivery");
    }
  }, [fulfillment, pickupOff, deliveryOff, curbsideOff]);

  // Load the signed-in customer's profile: greet them and prefill the
  // checkout form from their saved details (only into fields still empty).
  async function loadAccountFromToken(token: string) {
    try {
      const res = await fetch("/api/account/me", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) return;
      const me = await res.json();
      const p = me.profile ?? {};
      setAccountName(p.display_name || me.email || "My account");
      setAccountEmail(me.email ?? null);
      if (p.display_name) {
        const parts = p.display_name.trim().split(/\s+/);
        setFirstName((prev) => prev || parts[0] || "");
        if (parts.length > 1)
          setLastName((prev) => prev || parts.slice(1).join(" "));
      }
      if (p.phone) setPhone((prev) => prev || p.phone);
      if (p.default_address) setAddress((prev) => prev || p.default_address);
      // Loyalty balance for the checkout points box (rides along with /me).
      if (me.points && typeof me.points.balance === "number") {
        setPointsBalance(me.points.balance);
        if (typeof me.points.unlocked === "boolean") {
          setPointsGate({
            unlocked: me.points.unlocked,
            monthSpentCents: me.points.monthSpentCents ?? 0,
            remainingToUnlockCents: me.points.remainingToUnlockCents ?? 0,
          });
        }
      }
    } catch {
      /* guest checkout is unaffected */
    }
  }

  useEffect(() => {
    const client = getBrowserClient();
    if (!client) return;
    client.auth
      .getSession()
      .then(async ({ data }) => {
        const token = data.session?.access_token;
        if (token) await loadAccountFromToken(token);
        // Returning from Google sign-in: re-open the checkout panel.
        try {
          if (token && sessionStorage.getItem("mm_open_checkout") === "1") {
            sessionStorage.removeItem("mm_open_checkout");
            setShowCheckout(true);
            setTimeout(
              () => document.getElementById("checkout")?.scrollIntoView({ behavior: "smooth" }),
              80
            );
          }
        } catch {
          /* ignore */
        }
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Sign in without leaving checkout (the "Sign in or continue as guest"
  // choice at the top of the checkout panel).
  async function inlineSignIn() {
    setSiError("");
    setSiBusy(true);
    try {
      const client = getBrowserClient();
      if (!client) throw new Error("Sign-in is not available right now.");
      const { data, error } = await client.auth.signInWithPassword({
        email: siEmail.trim(),
        password: siPassword,
      });
      if (error) throw new Error(error.message);
      const token = data.session?.access_token;
      if (token) await loadAccountFromToken(token);
      setSiOpen(false);
      setSiPassword("");
    } catch (e) {
      setSiError(e instanceof Error ? e.message : "Sign-in failed. Please try again.");
    } finally {
      setSiBusy(false);
    }
  }

  // Google sign-in leaves the site and comes back; remember to re-open
  // the checkout panel on return (the cart itself survives in localStorage).
  async function googleSignIn() {
    setSiError("");
    try {
      const client = getBrowserClient();
      if (!client) throw new Error("unavailable");
      try {
        sessionStorage.setItem("mm_open_checkout", "1");
      } catch {
        /* ignore */
      }
      const { error } = await client.auth.signInWithOAuth({
        provider: "google",
        options: { redirectTo: `${window.location.origin}/menu` },
      });
      if (error) throw new Error(error.message);
    } catch {
      setSiError(
        "Google sign-in is not switched on yet — please use email sign-in or continue as guest."
      );
    }
  }

  async function inlineSignOut() {
    const client = getBrowserClient();
    if (client) await client.auth.signOut().catch(() => {});
    setAccountName(null);
    setAccountEmail(null);
    setGuestChosen(false);
    setPointsBalance(null);
    setUsePoints(false);
  }

  const menuById = useMemo(
    () => Object.fromEntries(menu.map((m) => [m.id, m])),
    [menu]
  );

  const lines: DisplayLine[] = useMemo(() => {
    const out: DisplayLine[] = [];
    for (const cl of cart) {
      const item = menuById[cl.id];
      if (!item) continue;
      const unit =
        item.price_cents +
        cl.options.reduce((s, o) => s + (o.price_delta_cents || 0), 0);
      out.push({
        key: lineKey(cl),
        cartLine: cl,
        item,
        qty: cl.qty,
        unit_cents: unit,
        line_total_cents: unit * cl.qty,
      });
    }
    return out;
  }, [cart, menuById]);

  const itemCount = lines.reduce((s, l) => s + l.qty, 0);
  const subtotal = lines.reduce((s, l) => s + l.line_total_cents, 0);
  // Loyalty preview: whole 100-point blocks ($5.00 each), capped by the
  // subtotal. The server recomputes this authoritatively at checkout.
  const redeemBlocks =
    usePoints && pointsBalance !== null && pointsGate?.unlocked
      ? Math.min(Math.floor(pointsBalance / 100), Math.floor(subtotal / 500))
      : 0;
  const discountPreview = redeemBlocks * 500;
  const tax = taxFor(subtotal - discountPreview);
  const tipCustomCents = tipCustom ? Math.round(Number(tipCustom) * 100) : NaN;
  const tip =
    tipCustom && Number.isFinite(tipCustomCents)
      ? Math.min(Math.max(tipCustomCents, 0), 20000)
      : Math.round((subtotal * Math.min(Math.max(tipPercent, 0), 30)) / 100);
  // Service Fee preview — same pure function the server uses, on the
  // food subtotal (before the loyalty discount, exactly like checkout).
  const serviceFeePreview = computeServiceFeeCents(
    subtotal,
    fees?.service_fee ?? DEFAULT_SERVICE_FEE
  );
  // Delivery providers: the flat-fee NO-quote path applies ONLY
  // when Shipday is the single enabled provider. Whenever House
  // Delivery or DoorDash is also ON, the quote endpoint resolves
  // the provider (House → DoorDash → Shipday, with radius
  // fall-through) and stores the fee — checkout then verifies the
  // stored quote, exactly like the DoorDash flow. Older payloads
  // (no switch fields) fall back to the legacy single provider.
  const dlSettings = siteState?.settings;
  const enablesKnown =
    !!dlSettings &&
    (dlSettings.delivery_house_enabled !== undefined ||
      dlSettings.delivery_doordash_enabled !== undefined ||
      dlSettings.delivery_shipday_enabled !== undefined);
  const shipdayMode = enablesKnown
    ? dlSettings.delivery_shipday_enabled === true &&
      dlSettings.delivery_house_enabled !== true &&
      dlSettings.delivery_doordash_enabled !== true
    : dlSettings?.delivery_provider === "shipday";
  const shipdayFeeCents = Math.max(
    0,
    Math.round(siteState?.settings.shipday_delivery_fee_cents ?? 699)
  );
  const shipdayFreeDelivery =
    shipdayMode &&
    freeDeliveryApplies(subtotal, fees?.free_delivery ?? DEFAULT_FREE_DELIVERY);
  const deliveryFee =
    fulfillment !== "delivery"
      ? 0
      : shipdayMode
        ? shipdayFreeDelivery
          ? 0
          : shipdayFeeCents
        : fee.kind === "ok"
          ? fee.delivery_charge_cents
          : 0;
  const total = subtotal - discountPreview + serviceFeePreview + tax + deliveryFee + tip;

  // The header bag pill shows "count · subtotal" like the reference
  // site — TopNav has no menu prices, so the subtotal is shared with
  // it through localStorage whenever it changes.
  useEffect(() => {
    try {
      localStorage.setItem("mm_cart_subtotal_cents", String(subtotal));
    } catch {
      /* private mode — the pill simply shows the count alone */
    }
    window.dispatchEvent(new Event(CART_EVENT));
  }, [subtotal]);

  // Add (or merge) a cart line: same dish + same options + same
  // instructions merges; anything different stays a separate line.
  const addLine = useCallback(
    (item: MenuItem, qty: number, options: SelectedOption[], instructions: string) => {
      const incoming: CartLine = { id: item.id, qty, options, instructions };
      const key = lineKey(incoming);
      setCart((prev) => {
        const idx = prev.findIndex((l) => lineKey(l) === key);
        if (idx === -1) return [...prev, incoming];
        const next = [...prev];
        next[idx] = { ...next[idx], qty: Math.min(next[idx].qty + qty, 50) };
        return next;
      });
    },
    []
  );

  // Quantity of the plain (no options, no instructions) line of a dish —
  // used by the simple Add/stepper controls on dishes without options.
  const plainQty = useCallback(
    (itemId: string) =>
      cart.find((l) => l.id === itemId && l.options.length === 0 && !l.instructions)
        ?.qty ?? 0,
    [cart]
  );

  const setPlainQty = useCallback((item: MenuItem, qty: number) => {
    setCart((prev) => {
      const idx = prev.findIndex(
        (l) => l.id === item.id && l.options.length === 0 && !l.instructions
      );
      if (qty <= 0) {
        return idx === -1 ? prev : prev.filter((_, i) => i !== idx);
      }
      if (idx === -1) {
        return [...prev, { id: item.id, qty: Math.min(qty, 50), options: [], instructions: "" }];
      }
      const next = [...prev];
      next[idx] = { ...next[idx], qty: Math.min(qty, 50) };
      return next;
    });
  }, []);

  const setLineQty = useCallback((key: string, qty: number) => {
    setCart((prev) =>
      qty <= 0
        ? prev.filter((l) => lineKey(l) !== key)
        : prev.map((l) => (lineKey(l) === key ? { ...l, qty: Math.min(qty, 50) } : l))
    );
  }, []);

  const totalQtyFor = useCallback(
    (itemId: string) =>
      cart.filter((l) => l.id === itemId).reduce((s, l) => s + l.qty, 0),
    [cart]
  );

  // Fly-to-bag animation (Sami's pick — option B): a clone of the dish
  // photo flies from the card / options popup to the floating bag bar,
  // which then pulses once. Purely visual and fully guarded — the cart
  // state updates exactly as before, and any failure here is ignored.
  const flyToBag = useCallback(
    (sourceImg: HTMLImageElement | null, src: string) => {
      try {
        if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches)
          return;
        const start = sourceImg?.getBoundingClientRect();
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const sx = start ? start.left + start.width / 2 : vw / 2;
        const sy = start ? start.top + start.height / 2 : vh / 2;
        const size = start ? Math.max(48, Math.min(start.width, 200)) : 120;
        // The bag bar exists only once the cart is non-empty, so wait
        // two frames for it to render before measuring it. If it is
        // still missing, aim at where it sits (bottom centre).
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            try {
              const bar = document.querySelector<HTMLElement>(".cart-bar");
              const rect = bar?.getBoundingClientRect();
              const ex = rect ? rect.left + rect.width / 2 : vw / 2;
              const ey = rect ? rect.top + rect.height / 2 : vh - 44;
              const clone = document.createElement("img");
              clone.src = src;
              clone.alt = "";
              clone.setAttribute("aria-hidden", "true");
              Object.assign(clone.style, {
                position: "fixed",
                left: `${sx - size / 2}px`,
                top: `${sy - size / 2}px`,
                width: `${size}px`,
                height: `${size}px`,
                objectFit: "cover",
                borderRadius: "18px",
                zIndex: "999",
                pointerEvents: "none",
                margin: "0",
                boxShadow: "0 12px 32px rgba(0,0,0,0.35)",
              });
              document.body.appendChild(clone);
              const dx = ex - sx;
              const dy = ey - sy;
              const anim = clone.animate(
                [
                  { transform: "translate(0px, 0px) scale(1)", opacity: "1" },
                  {
                    transform: `translate(${dx * 0.72}px, ${
                      dy * 0.72 - 56
                    }px) scale(0.32)`,
                    opacity: "0.9",
                    offset: 0.72,
                  },
                  {
                    transform: `translate(${dx}px, ${dy}px) scale(0.05)`,
                    opacity: "0.2",
                  },
                ],
                { duration: 650, easing: "cubic-bezier(.45,.02,.35,1)" }
              );
              anim.onfinish = () => {
                clone.remove();
                try {
                  bar?.animate(
                    [
                      { transform: "translateX(-50%) scale(1)" },
                      { transform: "translateX(-50%) scale(1.07)", offset: 0.4 },
                      { transform: "translateX(-50%) scale(1)" },
                    ],
                    { duration: 320, easing: "ease-out" }
                  );
                } catch {
                  /* the pulse is decorative only */
                }
              };
              anim.oncancel = () => clone.remove();
              setTimeout(() => clone.remove(), 1600);
            } catch {
              /* the animation must never break adding to the cart */
            }
          });
        });
      } catch {
        /* the animation must never break adding to the cart */
      }
    },
    []
  );

  // Dish-card "+ Add" / stepper "+": update the cart exactly as before
  // and fly the card's photo to the bag bar.
  const handleQuickAdd = (
    e: ReactMouseEvent<HTMLElement>,
    item: MenuItem,
    qty: number
  ) => {
    const card = (e.currentTarget as HTMLElement).closest("article");
    const img = card?.querySelector("img") as HTMLImageElement | null;
    setPlainQty(item, qty);
    flyToBag(img, dishPhotos[item.id] ?? item.image);
  };

  // Debounced DoorDash delivery quote while the address is typed
  // (Stage 3: /api/delivery-quote stores the quote server-side; the
  // quote id goes to checkout, which re-loads the fee from the store —
  // the browser's numbers are never trusted). The tip is an input
  // because tipping the driver lowers the DoorDash fee.
  // Shipday mode never quotes: the fee is the flat admin-set amount.
  useEffect(() => {
    if (fulfillment !== "delivery") return;
    if (shipdayMode) return;
    if (feeTimer.current) clearTimeout(feeTimer.current);
    const trimmed = address.trim();
    if (trimmed.length < 6) {
      setFee({ kind: "idle" });
      return;
    }
    setFee({ kind: "loading" });
    const seq = ++feeSeq.current;
    feeTimer.current = setTimeout(async () => {
      try {
        const res = await fetch("/api/delivery-quote", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            address: trimmed,
            phone: phone.trim() || undefined,
            tip_cents: tip,
            subtotal_cents: subtotal,
          }),
        });
        const data = await res.json();
        if (seq !== feeSeq.current) return; // a newer quote is in flight
        if (data.error === "far") {
          setFee({ kind: "far", message: String(data.message ?? "That address is outside our delivery area.") });
        } else if (data.error === "not_found") {
          setFee({ kind: "not_found" });
        } else if (data.error) {
          setFee({
            kind: "error",
            message: String(data.message ?? "We could not get a delivery quote right now."),
          });
        } else {
          const eta =
            data.provider === "house"
              ? "🏠 Delivered by our own driver"
              : data.estimated_dropoff_at
                ? `Arrives about ${new Date(data.estimated_dropoff_at).toLocaleTimeString([], {
                    hour: "numeric",
                    minute: "2-digit",
                  })}`
                : "";
          setFee({
            kind: "ok",
            quote_id: String(data.quote_id),
            fee_cents: Number(data.fee_cents) || 0,
            service_fee_cents: Number(data.service_fee_cents) || 0,
            delivery_charge_cents:
              Number(data.delivery_charge_cents) ||
              (Number(data.fee_cents) || 0) + (Number(data.service_fee_cents) || 0),
            free_delivery: data.free_delivery === true,
            label: eta,
            expires_at: String(data.expires_at),
          });
        }
      } catch {
        if (seq === feeSeq.current) {
          setFee({
            kind: "error",
            message: "We could not get a delivery quote right now. Please try again.",
          });
        }
      }
    }, 700);
    return () => {
      if (feeTimer.current) clearTimeout(feeTimer.current);
    };
  }, [address, fulfillment, phone, tip, quoteNonce, subtotal, shipdayMode]); // eslint-disable-line react-hooks/exhaustive-deps

  // Quote expiry: when the stored quote lapses, refresh it and show
  // the (possibly changed) fee before the customer pays — a changed
  // total is never charged silently.
  useEffect(() => {
    if (fee.kind !== "ok") return;
    const ms = new Date(fee.expires_at).getTime() - Date.now();
    const fire = () => {
      setFee({ kind: "expired" });
      setQuoteNonce((n) => n + 1);
    };
    if (ms <= 0) {
      fire();
      return;
    }
    const t = setTimeout(fire, ms);
    return () => clearTimeout(t);
  }, [fee]);

  // DoorDash mode blocks checkout until a live quote exists; Shipday
  // mode only needs the address itself (the fee is flat).
  const checkoutBlocked =
    fulfillment === "delivery" &&
    (shipdayMode ? address.trim().length < 6 : fee.kind !== "ok");

  // Checkout is a two-step flow (Sami's spec): first the customer chooses
  // Sign in / Sign in with Google / Continue as guest — only then does the
  // details form (name, phone, tip…) appear, prefilled when signed in.
  const formOpen = !!accountEmail || guestChosen;
  const fullName = `${firstName} ${lastName}`.trim();

  // Step 1 → Step 2 (Review): the same client-side checks placeOrder
  // runs before submitting (the server still validates everything
  // again at placement). All form input stays untouched, so "← Back"
  // from the review step returns to a fully preserved form.
  function goToReview() {
    setError("");
    if (lines.length === 0) return setError("Your cart is empty.");
    if (fullName.length < 2) return setError("Please enter your name.");
    if (phone.replace(/\D/g, "").length < 7)
      return setError("Please enter your phone number.");
    if (fulfillment === "delivery" && shipdayMode && address.trim().length < 6) {
      return setError("Please enter the delivery address.");
    }
    if (fulfillment === "delivery" && !shipdayMode && fee.kind !== "ok") {
      return setError(
        "Please enter a delivery address inside our delivery area first."
      );
    }
    if (fulfillment === "curbside" && car.trim().length < 3) {
      return setError("Please tell us your car (color & type) so we can find you outside.");
    }
    if (fulfillment === "pickup" && pickupWhen === "later") {
      const iso = pickupTime ? denverTimeTodayToISO(pickupTime) : null;
      if (!iso) return setError("Please choose a pickup time.");
      const problem = validatePickupTime(iso, new Date(), hoursCfg);
      if (problem) return setError(problem);
    }
    setCheckoutStep(2);
    setTimeout(
      () =>
        document
          .getElementById("checkout")
          ?.scrollIntoView({ behavior: "smooth" }),
      50
    );
  }

  async function placeOrder() {
    setError("");
    if (lines.length === 0) return setError("Your cart is empty.");
    if (fullName.length < 2) return setError("Please enter your name.");
    if (phone.replace(/\D/g, "").length < 7) return setError("Please enter your phone number.");
    if (fulfillment === "delivery" && shipdayMode && address.trim().length < 6) {
      return setError("Please enter the delivery address.");
    }
    if (fulfillment === "delivery" && !shipdayMode && fee.kind !== "ok") {
      return setError("Please enter a delivery address inside our delivery area first.");
    }
    if (fulfillment === "curbside" && car.trim().length < 3) {
      return setError("Please tell us your car (color & type) so we can find you outside.");
    }
    // Scheduled pickup ("pickup for later") — validated again on the server.
    let scheduledFor: string | undefined;
    if (fulfillment === "pickup" && pickupWhen === "later") {
      const iso = pickupTime ? denverTimeTodayToISO(pickupTime) : null;
      if (!iso) return setError("Please choose a pickup time.");
      const problem = validatePickupTime(iso, new Date(), hoursCfg);
      if (problem) return setError(problem);
      scheduledFor = iso;
    }
    setPlacing(true);
    try {
      // Attach the account session (if any) so the order is saved to the
      // customer's history. Guests send no header and stay anonymous.
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      try {
        const client = getBrowserClient();
        const { data } = client ? await client.auth.getSession() : { data: { session: null } };
        const token = data.session?.access_token;
        if (token) headers.Authorization = `Bearer ${token}`;
      } catch {
        /* proceed as guest */
      }
      const res = await fetch("/api/checkout", {
        method: "POST",
        headers,
        body: JSON.stringify({
          items: lines.map((l) => ({
            id: l.item.id,
            qty: l.qty,
            ...(l.cartLine.options.length > 0
              ? {
                  options: l.cartLine.options.map((o) => ({
                    group: o.group,
                    name: o.name,
                  })),
                }
              : {}),
            ...(l.cartLine.instructions
              ? { instructions: l.cartLine.instructions }
              : {}),
          })),
          customer_name: fullName,
          customer_phone: phone.trim(),
          fulfillment,
          delivery_address: fulfillment === "delivery" ? address.trim() : undefined,
          car_description: fulfillment === "curbside" ? car.trim() : undefined,
          delivery_quote_id:
            fulfillment === "delivery" && fee.kind === "ok" ? fee.quote_id : undefined,
          note: note.trim() || undefined,
          ...(tipCustom && Number.isFinite(tipCustomCents)
            ? { tip_custom_cents: tipCustomCents }
            : { tip_percent: tipPercent }),
          ...(usePoints ? { use_points: true } : {}),
          ...(scheduledFor ? { scheduled_for: scheduledFor } : {}),
        }),
      });
      const data = await res.json();
      if (!res.ok && data.code === "quote_expired") {
        // Refresh the quote so the customer sees and confirms the new
        // total before paying — never charge a silently changed fee.
        // Back to step 1, where the refreshed fee and this message show.
        setQuoteNonce((n) => n + 1);
        setCheckoutStep(1);
        throw new Error(
          "The delivery quote expired — we refreshed the fee. Please review the new total, then place the order again."
        );
      }
      if (!res.ok) throw new Error(data.error || "Checkout failed");
      // Remember this order (fulfillment + phone) so the confirmation
      // banner can offer the curbside "I'm here" button — including
      // after the Stripe redirect reloads the page.
      const placed = {
        id: data.order_id as number,
        fulfillment,
        phone: phone.trim(),
        car: fulfillment === "curbside" ? car.trim() : "",
      };
      setLastOrder(placed);
      try {
        sessionStorage.setItem("mm_last_order", JSON.stringify(placed));
      } catch {
        /* in-memory state still covers the test-mode path */
      }
      if (data.url) {
        window.location.href = data.url as string;
        return;
      }
      if (data.test_mode) {
        const payRes = await fetch("/api/test-pay", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ order_id: data.order_id }),
        });
        if (!payRes.ok) throw new Error("Test payment failed");
        setSuccessOrder(data.order_id as number);
        setCart([]);
        clearCart();
        setShowCheckout(false);
        window.scrollTo({ top: 0, behavior: "smooth" });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong. Please try again.");
    } finally {
      setPlacing(false);
    }
  }

  // ---- menu filtering (sidebar + search) -----------------------------------
  const q = query.trim().toLowerCase();
  const searching = q.length > 0;
  const matches = (m: MenuItem) =>
    !searching ||
    m.name.toLowerCase().includes(q) ||
    m.description.toLowerCase().includes(q);
  const visibleByCat = (cat: string) =>
    menu.filter((m) => m.category === cat && matches(m));

  function renderCard(m: MenuItem) {
    const soldOut = unavailableSet.has(m.id);
    const hasOptions = (m.option_groups?.length ?? 0) > 0;
    const qty = plainQty(m.id);
    const inCart = totalQtyFor(m.id);
    return (
      <article className="card" key={m.id}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={dishPhotos[m.id] ?? m.image}
          alt={m.name}
          loading="lazy"
          onClick={hasOptions ? () => setPopupItem(m) : undefined}
          style={hasOptions ? { cursor: "pointer" } : undefined}
          onError={(e) => {
            (e.target as HTMLImageElement).style.visibility = "hidden";
          }}
        />
        <div className="card-body">
          <h3>
            {m.number && <span className="num">{m.number}</span>}
            {m.name}
          </h3>
          <p>{m.description}</p>
          {hasOptions && <p className="has-options">✦ Has add-ons &amp; options</p>}
          <div className="price-row">
            <span className="price">
              {hasOptions && <span className="from">from </span>}
              {formatCents(m.price_cents)}
            </span>
            {soldOut ? (
              <>
                <span className="soldout-badge">Sold out</span>
                {qty > 0 && (
                  <span className="qty-controls">
                    <button type="button" onClick={() => setPlainQty(m, qty - 1)} aria-label="Remove one">
                      −
                    </button>
                    <span className="count">{qty}</span>
                  </span>
                )}
              </>
            ) : hasOptions ? (
              <button type="button" className="add-btn" onClick={() => setPopupItem(m)}>
                {inCart > 0 ? `Add more · ${inCart} in cart` : "+ Add"}
              </button>
            ) : orderingClosed && qty === 0 ? (
              <button type="button" className="add-btn" disabled>
                Closed
              </button>
            ) : qty === 0 ? (
              <button type="button" className="add-btn" onClick={(e) => handleQuickAdd(e, m, 1)}>
                + Add
              </button>
            ) : (
              <span className="qty-controls">
                <button type="button" onClick={() => setPlainQty(m, qty - 1)} aria-label="Remove one">
                  −
                </button>
                <span className="count">{qty}</span>
                <button type="button" onClick={(e) => handleQuickAdd(e, m, qty + 1)} aria-label="Add one">
                  +
                </button>
              </span>
            )}
          </div>
        </div>
      </article>
    );
  }

  // Cart lines for the checkout panel. Step 1 (details) keeps the
  // quantity steppers + Remove; step 2 (review) shows the same lines
  // read-only, with their options and per-line totals.
  const renderLines = (editable: boolean) =>
    lines.map((l) => (
      <div className="cart-line-wrap" key={l.key}>
        <div className="cart-line">
          {editable && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              className="line-photo"
              src={dishPhotos[l.item.id] ?? l.item.image}
              alt=""
            />
          )}
          <span>
            {l.qty} × {l.item.name}
          </span>
          <span>{formatCents(l.line_total_cents)}</span>
        </div>
        {l.cartLine.options.length > 0 && (
          <div className="line-options">
            {l.cartLine.options.map((o) => (
              <span key={`${o.group}::${o.name}`}>
                • {o.name}
                {o.price_delta_cents > 0
                  ? ` (+${formatCents(o.price_delta_cents)})`
                  : ""}
              </span>
            ))}
          </div>
        )}
        {l.cartLine.instructions && (
          <div className="line-note">“{l.cartLine.instructions}”</div>
        )}
        {editable && (
          <div className="line-controls">
            <span className="qty-controls small">
              <button type="button" onClick={() => setLineQty(l.key, l.qty - 1)} aria-label="One less">
                −
              </button>
              <span className="count">{l.qty}</span>
              <button type="button" onClick={() => setLineQty(l.key, l.qty + 1)} aria-label="One more">
                +
              </button>
            </span>
            <button
              type="button"
              className="auth-link"
              onClick={() => setLineQty(l.key, 0)}
            >
              Remove
            </button>
          </div>
        )}
      </div>
    ));

  // Review-screen summary rows (reference-site style): what was chosen
  // in Details, each with an Edit jump back to the details screen.
  const reviewSummaryJsx = (
    <div className="review-summary">
      <div className="review-row">
        <div>
          <strong>
            {fulfillment === "delivery"
              ? "🛵 Delivery"
              : fulfillment === "curbside"
                ? "🚗 Curbside pickup"
                : "🏃 Pickup at Madinah Market"}
          </strong>
          <span>
            {fulfillment === "delivery"
              ? address || "—"
              : fulfillment === "curbside"
                ? car || "—"
                : "3126 S Parker Rd, Aurora, CO 80014"}
          </span>
        </div>
        <button type="button" className="auth-link" onClick={() => setCheckoutStep(1)}>
          Edit
        </button>
      </div>
      <div className="review-row">
        <div>
          <strong>
            🕙 {pickupWhen === "later" ? `Today at ${pickupTime}` : "As soon as possible"}
          </strong>
          <span>{fulfillment === "delivery" ? "Delivery time" : "Pickup time"}</span>
        </div>
        <button type="button" className="auth-link" onClick={() => setCheckoutStep(1)}>
          Edit
        </button>
      </div>
      <div className="review-row">
        <div>
          <strong>👤 {`${firstName} ${lastName}`.trim() || "—"}</strong>
          <span>{phone || "—"}</span>
        </div>
        <button type="button" className="auth-link" onClick={() => setCheckoutStep(1)}>
          Edit
        </button>
      </div>
    </div>
  );

  // Totals block — the exact same rows, in the established order, on
  // both checkout steps (display only; the server recomputes at
  // placement). The Delivery fee is the ONE merged customer line.
  const breakdownJsx = (
    <div className="breakdown">
      <div className="row">
        <span>Subtotal</span>
        <span>{formatCents(subtotal)}</span>
      </div>
      {discountPreview > 0 && (
        <div className="row">
          <span>⭐ Loyalty discount ({redeemBlocks * 100} pts)</span>
          <span>−{formatCents(discountPreview)}</span>
        </div>
      )}
      {serviceFeePreview > 0 && (
        <div className="row">
          <span>Service fee</span>
          <span>{formatCents(serviceFeePreview)}</span>
        </div>
      )}
      <div className="row">
        <span>Sales tax (8%)</span>
        <span>{formatCents(tax)}</span>
      </div>
      {fulfillment === "delivery" && (
        <div className="row">
          <span>Delivery fee</span>
          <span>
            {shipdayMode
              ? shipdayFreeDelivery
                ? "FREE 🎉"
                : formatCents(shipdayFeeCents)
              : fee.kind === "ok"
                ? fee.free_delivery
                  ? "FREE 🎉"
                  : formatCents(fee.delivery_charge_cents)
                : "—"}
          </span>
        </div>
      )}
      {tip > 0 && (
        <div className="row">
          <span>Tip</span>
          <span>{formatCents(tip)}</span>
        </div>
      )}
      <div className="row grand">
        <span>TOTAL</span>
        <span>{formatCents(total)}</span>
      </div>
    </div>
  );

  return (
    <>
      {testMode && (
        <div className="testmode-banner">
          TEST MODE — no real payment is taken. Orders are marked “test paid”.
        </div>
      )}

      {orderingClosed && (
        <div className="closed-banner">
          🔴 Online ordering is closed right now — please call us at{" "}
          <a href="tel:+17207630786">720-763-0786</a>. You can still browse the menu.
        </div>
      )}

      {promos.map((p) => {
        const dish = p.item_id ? menu.find((m) => m.id === p.item_id) : null;
        return (
          <div className="promo-box" key={p.id}>
            {dish && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={dishPhotos[dish.id] ?? dish.image} alt={dish.name} />
            )}
            <div className="promo-text">
              <strong>🎁 {p.title}</strong>
              {p.body && <span>{p.body}</span>}
              {dish && (
                <span className="promo-dish">
                  {dish.name} · {formatCents(dish.price_cents)}
                </span>
              )}
            </div>
          </div>
        );
      })}

      <main className="wrap">
        {successOrder !== null && (
          <div className="success-banner">
            ✅ <strong>Order #{successOrder} received!</strong> Thank you — we are on it.
            <br />
            <Link href={`/track?order=${successOrder}`}>Track your order →</Link>
            {lastOrder?.id === successOrder && lastOrder.fulfillment === "curbside" && (
              <CurbsideHere
                orderId={successOrder}
                phone={lastOrder.phone}
                alreadyHere={false}
                carDescription={lastOrder.car || null}
              />
            )}
          </div>
        )}

        {qrSource && !showCheckout && (
          <div className="qr-note">👋 Order here — no app download needed. Pay online, we’ll handle the rest.</div>
        )}

        {installEvent && !showCheckout && (
          <div className="install-row">
            <button
              type="button"
              onClick={async () => {
                await installEvent.prompt();
                setInstallEvent(null);
              }}
            >
              📲 Install the Madinah app
            </button>
          </div>
        )}

        <div
          className={showCheckout ? "menu-layout checkout-open" : "menu-layout"}
          id="menu-top"
        >
          <aside className="menu-sidebar">
            <h2 className="sidebar-title">Menu</h2>
            <button
              type="button"
              className={activeCat === "All" ? "active" : ""}
              onClick={() => setActiveCat("All")}
            >
              All dishes
            </button>
            {categories.map((c) => (
              <button
                key={c}
                type="button"
                className={activeCat === c ? "active" : ""}
                onClick={() => setActiveCat(c)}
              >
                {c}
              </button>
            ))}
            <div className="sidebar-account">
              {accountName ? (
                <Link href="/account">👤 {accountName}</Link>
              ) : (
                <Link href="/account">👤 Log in</Link>
              )}
            </div>
          </aside>

          <div className="menu-main">
            <div className="menu-search">
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="🔍 Search the menu — try “kabob” or “falafel”"
                aria-label="Search the menu"
              />
            </div>

            {searching ? (
              <section>
                <h2 className="category-title">
                  Results for “{query.trim()}” ({menu.filter(matches).length})
                </h2>
                <div className="menu-grid">{menu.filter(matches).map(renderCard)}</div>
                {menu.filter(matches).length === 0 && (
                  <p>No dishes match — try another word, or browse the categories.</p>
                )}
              </section>
            ) : activeCat !== "All" ? (
              <section>
                <h2 className="category-title">{activeCat}</h2>
                <div className="menu-grid">{visibleByCat(activeCat).map(renderCard)}</div>
              </section>
            ) : (
              categories.map((category) => (
                <section key={category}>
                  <h2 className="category-title">{category}</h2>
                  <div className="menu-grid">{visibleByCat(category).map(renderCard)}</div>
                </section>
              ))
            )}
          </div>
        </div>

        {showCheckout && (
          <section
            className="panel checkout-sheet"
            id="checkout"
            style={
              sheetBox
                ? { top: sheetBox.top, height: sheetBox.height }
                : undefined
            }
          >
            <div
              className={
                checkoutStep === 0
                  ? "sheet-inner sheet-inner--wide"
                  : "sheet-inner"
              }
            >
            <div className="panel-head">
              <h3>
                {checkoutStep === 0
                  ? "Your bag"
                  : checkoutStep === 1
                    ? "Checkout"
                    : "Review your order"}
              </h3>
              {checkoutStep === 0 ? (
                <button
                  type="button"
                  className="back-link"
                  onClick={() => {
                    setShowCheckout(false);
                    setTimeout(
                      () =>
                        document
                          .getElementById("menu-top")
                          ?.scrollIntoView({ behavior: "smooth" }),
                      50
                    );
                  }}
                >
                  ← Back to menu
                </button>
              ) : (
                <button
                  type="button"
                  className="back-link"
                  onClick={() => {
                    setError("");
                    setCheckoutStep(checkoutStep === 2 ? 1 : 0);
                  }}
                >
                  {checkoutStep === 2 ? "← Back to details" : "← Back to bag"}
                </button>
              )}
            </div>
            <div className="checkout-scroll" ref={checkoutScrollRef}>
            {checkoutStep === 0 && (
              <div className="bag-layout">
                <div className="bag-lines">
                  {renderLines(true)}
                  {lines.length === 0 && (
                    <p>Your bag is empty — go back to the menu and add something tasty.</p>
                  )}
                </div>
                {lines.length > 0 && (
                  <aside className="bag-summary">
                    <div className="bag-howto">
                      <h4>How to get it</h4>
                      {reviewSummaryJsx}
                    </div>
                    <div className="bag-tip">
                      <h4>Add a tip</h4>
                      <div className="tip-tiles">
                        {[10, 15, 20].map((pct) => (
                          <button
                            type="button"
                            key={pct}
                            className={
                              "tip-tile" +
                              (!tipCustom && tipPercent === pct ? " on" : "")
                            }
                            onClick={() => {
                              setTipPercent(pct);
                              setTipCustom("");
                            }}
                          >
                            <strong>{pct}%</strong>
                            <small>
                              {formatCents(Math.round((subtotal * pct) / 100))}
                            </small>
                          </button>
                        ))}
                        <button
                          type="button"
                          className={
                            "tip-tile" +
                            (!tipCustom && tipPercent === 0 ? " on" : "")
                          }
                          onClick={() => {
                            setTipPercent(0);
                            setTipCustom("");
                          }}
                        >
                          <strong>No tip</strong>
                          <small>$0.00</small>
                        </button>
                      </div>
                      {tipCustom && (
                        <p className="bag-tip-note">
                          Custom tip: {formatCents(tip)} — you can change it
                          on the next screen.
                        </p>
                      )}
                    </div>
                    {breakdownJsx}
                  </aside>
                )}
              </div>
            )}
            {checkoutStep === 2 && (
              <>
                {reviewSummaryJsx}
                {renderLines(false)}
                {breakdownJsx}
                {error && <div className="form-error">{error}</div>}
              </>
            )}

            {checkoutStep === 1 && (
              <>
            {!formOpen ? (
              <div className="auth-box">
                <strong>Sign in or continue as guest</strong>
                <div className="toggle-row">
                  <button
                    type="button"
                    className={siOpen ? "active" : ""}
                    onClick={() => setSiOpen(true)}
                  >
                    🔑 Sign in
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setGuestChosen(true);
                      setSiOpen(false);
                    }}
                  >
                    👤 Continue as guest
                  </button>
                </div>
                <button type="button" className="google-btn" onClick={googleSignIn}>
                  Sign in with Google
                </button>
                {siOpen && (
                  <div>
                    <div className="field">
                      <label htmlFor="si-email">Email</label>
                      <input
                        id="si-email"
                        type="email"
                        value={siEmail}
                        onChange={(e) => setSiEmail(e.target.value)}
                        autoComplete="email"
                      />
                    </div>
                    <div className="field">
                      <label htmlFor="si-password">Password</label>
                      <input
                        id="si-password"
                        type="password"
                        value={siPassword}
                        onChange={(e) => setSiPassword(e.target.value)}
                        autoComplete="current-password"
                      />
                    </div>
                    {siError && <div className="fee-msg err">{siError}</div>}
                    <button
                      type="button"
                      className="checkout-btn"
                      disabled={siBusy || !siEmail || !siPassword}
                      onClick={inlineSignIn}
                    >
                      {siBusy ? "Signing in…" : "Sign in & continue"}
                    </button>
                    <div className="fee-msg">
                      New here? <Link href="/account">Create an account</Link> — it takes 30
                      seconds.
                    </div>
                  </div>
                )}
              </div>
            ) : accountEmail ? (
              <div className="auth-box">
                <div className="fee-msg ok">
                  ✓ Signed in as {accountEmail} — your saved details are filled in below, and
                  this order will be saved to your account.
                </div>
                <button type="button" className="auth-link" onClick={inlineSignOut}>
                  Not you? Log out
                </button>
              </div>
            ) : (
              <div className="auth-box">
                <span>👤 Checking out as guest · </span>
                <button
                  type="button"
                  className="auth-link"
                  onClick={() => setGuestChosen(false)}
                >
                  ← Back
                </button>
              </div>
            )}

            {formOpen && (
              <>
            <div className="toggle-row">
              <button
                type="button"
                className={fulfillment === "pickup" ? "active" : ""}
                onClick={() => setFulfillment("pickup")}
                disabled={pickupOff}
              >
                🏃 Pickup{pickupOff ? " (off)" : ""}
              </button>
              <button
                type="button"
                className={fulfillment === "curbside" ? "active" : ""}
                onClick={() => setFulfillment("curbside")}
                disabled={curbsideOff}
              >
                🚗 Curbside{curbsideOff ? " (off)" : ""}
              </button>
              <button
                type="button"
                className={fulfillment === "delivery" ? "active" : ""}
                onClick={() => setFulfillment("delivery")}
                disabled={deliveryOff}
              >
                🛵 Delivery{deliveryOff ? " (off)" : ""}
              </button>
            </div>
            <div className="fee-msg">
              {fulfillment === "delivery"
                ? `Delivery today: ${formatWindow(deliveryWins[denverParts(new Date()).dayIndex])}`
                : fulfillment === "curbside"
                  ? `Curbside today: ${formatWindow(pickupWins[denverParts(new Date()).dayIndex])} — order online, park outside, and we bring it to your car.`
                  : `Pickup today: ${formatWindow(pickupWins[denverParts(new Date()).dayIndex])}`}
            </div>

            {fulfillment === "pickup" && (
              <div className="field">
                <label>Pickup time</label>
                <div className="toggle-row">
                  <button
                    type="button"
                    className={pickupWhen === "asap" ? "active" : ""}
                    onClick={() => setPickupWhen("asap")}
                  >
                    ⚡ As soon as possible
                  </button>
                  <button
                    type="button"
                    className={pickupWhen === "later" ? "active" : ""}
                    onClick={() => setPickupWhen("later")}
                  >
                    ⏰ Later today
                  </button>
                </div>
                {pickupWhen === "later" && (
                  <>
                    <input
                      type="time"
                      value={pickupTime}
                      min={minutesToInputValue(pickupWindowToday(new Date(), hoursCfg).open)}
                      max={minutesToInputValue(pickupWindowToday(new Date(), hoursCfg).close)}
                      onChange={(e) => setPickupTime(e.target.value)}
                    />
                    <div className="fee-msg">
                      Pick any time today inside pickup hours (
                      {formatWindow(pickupWindowToday(new Date(), hoursCfg))}) — e.g. in 2 or 3 hours.
                    </div>
                  </>
                )}
              </div>
            )}

            <div className="field">
              <label htmlFor="co-first">First name</label>
              <input
                id="co-first"
                value={firstName}
                onChange={(e) => setFirstName(e.target.value)}
                autoComplete="given-name"
              />
            </div>
            <div className="field">
              <label htmlFor="co-last">Last name</label>
              <input
                id="co-last"
                value={lastName}
                onChange={(e) => setLastName(e.target.value)}
                autoComplete="family-name"
              />
            </div>
            <div className="field">
              <label htmlFor="co-phone">Phone number</label>
              <input
                id="co-phone"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                autoComplete="tel"
                inputMode="tel"
              />
            </div>
            <p
              style={{
                fontSize: "0.8rem",
                opacity: 0.75,
                margin: "0.25rem 0 0.75rem",
                lineHeight: 1.5,
              }}
            >
              By providing your phone number, you agree to receive text
              messages from Madinah Market about your order (confirmation,
              ready-for-pickup, and delivery updates). Message frequency
              varies; msg &amp; data rates may apply. Reply STOP to opt out.{" "}
              <a href="/privacy" target="_blank" rel="noreferrer">
                Privacy Policy
              </a>{" "}
              ·{" "}
              <a href="/terms" target="_blank" rel="noreferrer">
                Terms &amp; Conditions
              </a>
            </p>

            {fulfillment === "delivery" ? (
              <div className="field">
                <label htmlFor="co-address">Delivery address</label>
                <input
                  id="co-address"
                  value={address}
                  onChange={(e) => setAddress(e.target.value)}
                  placeholder="Street address, city, ZIP"
                  autoComplete="street-address"
                />
                {shipdayMode ? (
                  <div className="fee-msg ok">
                    {shipdayFreeDelivery
                      ? `🎉 Free delivery applied — your order reached ${formatCents(
                          fees?.free_delivery.threshold_cents ?? 0
                        )}!`
                      : `✅ Delivery fee ${formatCents(shipdayFeeCents)}`}
                  </div>
                ) : (
                  <>
                {fee.kind === "loading" && <div className="fee-msg">Checking delivery fee…</div>}
                {fee.kind === "ok" && (
                  <div className="fee-msg ok">
                    {fee.free_delivery
                      ? `🎉 Free delivery applied — your order reached ${formatCents(
                          fees?.free_delivery.threshold_cents ?? 0
                        )}!`
                      : `✅ Delivery fee ${formatCents(fee.delivery_charge_cents)}`}
                    {fee.label ? ` — ${fee.label}` : ""}
                  </div>
                )}
                {fee.kind === "far" && <div className="fee-msg err">{fee.message}</div>}
                {fee.kind === "not_found" && (
                  <div className="fee-msg err">We could not find that address — please check it.</div>
                )}
                {fee.kind === "expired" && (
                  <div className="fee-msg">Your delivery quote expired — refreshing the fee…</div>
                )}
                {fee.kind === "error" && (
                  <div className="fee-msg err">
                    {fee.message}{" "}
                    <button
                      type="button"
                      className="linklike"
                      onClick={() => setQuoteNonce((n) => n + 1)}
                    >
                      Try again
                    </button>
                  </div>
                )}
                  </>
                )}
              </div>
            ) : (
              <>
                {fulfillment === "curbside" && (
                  <div className="field">
                    <label htmlFor="co-car">Your car (color &amp; type)</label>
                    <input
                      id="co-car"
                      value={car}
                      onChange={(e) => setCar(e.target.value)}
                      placeholder="e.g. Red Toyota Camry"
                      autoComplete="off"
                    />
                    <div className="fee-msg">
                      So we can find you outside — park, tap “I&apos;m here” after
                      paying, and we&apos;ll bring your order out.
                    </div>
                  </div>
                )}
                <div className="field">
                  <label htmlFor="co-note">
                    {fulfillment === "curbside" ? "Note (optional)" : "Pickup note (optional)"}
                  </label>
                  <input
                    id="co-note"
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    placeholder="e.g. ready in 20 minutes"
                  />
                </div>
              </>
            )}

            <div className="field">
              <label>Add a tip (thank you!)</label>
              <div className="tip-row">
                {[0, 10, 15, 20].map((pct) => (
                  <button
                    type="button"
                    key={pct}
                    className={!tipCustom && tipPercent === pct ? "active" : ""}
                    onClick={() => {
                      setTipPercent(pct);
                      setTipCustom("");
                    }}
                  >
                    {pct === 0 ? "No tip" : `${pct}%`}
                  </button>
                ))}
              </div>
              <input
                className="tip-custom"
                type="number"
                min="0"
                step="0.5"
                placeholder="Custom $"
                value={tipCustom}
                onChange={(e) => setTipCustom(e.target.value)}
              />
            </div>

            {accountEmail && pointsBalance !== null && (
              <div className="auth-box">
                {pointsGate && !pointsGate.unlocked ? (
                  <span>
                    🔒 You have <strong>{pointsBalance} points</strong> — points
                    unlock when you spend $100 in a month. You&apos;ve spent{" "}
                    <strong>{formatCents(pointsGate.monthSpentCents)}</strong>{" "}
                    this month —{" "}
                    <strong>
                      {formatCents(pointsGate.remainingToUnlockCents)}
                    </strong>{" "}
                    to go.
                  </span>
                ) : pointsBalance >= 100 ? (
                  <label style={{ display: "flex", gap: "0.5rem", alignItems: "center", cursor: "pointer" }}>
                    <input
                      type="checkbox"
                      checked={usePoints}
                      onChange={(e) => setUsePoints(e.target.checked)}
                    />
                    <span>
                      ⭐ Use my points — you have <strong>{pointsBalance} pts</strong>
                      {redeemBlocks > 0 && usePoints
                        ? ` · ${formatCents(discountPreview)} off applied`
                        : ` · ${formatCents(Math.min(Math.floor(pointsBalance / 100) * 500, Math.floor(subtotal / 500) * 500))} off available`}
                    </span>
                  </label>
                ) : (
                  <span>
                    ⭐ You have <strong>{pointsBalance} points</strong> — earn{" "}
                    {100 - pointsBalance} more for $5.00 off.
                  </span>
                )}
              </div>
            )}

            {breakdownJsx}

            {error && <div className="form-error">{error}</div>}
              </>
            )}
              </>
            )}
            </div>
            {itemCount > 0 &&
              checkoutStep === 0 &&
              (orderingClosed ? (
                <div className="sheet-bar sheet-bar--center sheet-bar--static">
                  🔴 Ordering closed
                </div>
              ) : (
                <button
                  type="button"
                  className="sheet-bar"
                  onClick={() => setCheckoutStep(1)}
                >
                  <span>Checkout</span>
                  <span>{formatCents(subtotal)}</span>
                </button>
              ))}
            {checkoutStep === 1 &&
              (orderingClosed ? (
                <div className="sheet-bar sheet-bar--center sheet-bar--static">
                  🔴 Ordering closed — please call 720-763-0786
                </div>
              ) : (
                <button
                  type="button"
                  className="sheet-bar sheet-bar--center"
                  disabled={!formOpen || checkoutBlocked || lines.length === 0}
                  onClick={() => {
                    goToReview();
                    setTimeout(
                      () =>
                        document
                          .querySelector(".form-error")
                          ?.scrollIntoView({ behavior: "smooth", block: "center" }),
                      120
                    );
                  }}
                >
                  Review order →
                </button>
              ))}
            {checkoutStep === 2 && (
              <button
                type="button"
                className="sheet-bar"
                disabled={placing || orderingClosed || lines.length === 0}
                onClick={() => {
                  void placeOrder();
                  setTimeout(
                    () =>
                      document
                        .querySelector(".form-error")
                        ?.scrollIntoView({ behavior: "smooth", block: "center" }),
                    120
                  );
                }}
              >
                <span>{placing ? "Placing order…" : "Place order"}</span>
                <span>{formatCents(total)}</span>
              </button>
            )}
            </div>
          </section>
        )}
      </main>

      {!showCheckout && (
      <footer className="site-footer">
        Madinah Market · 3126 S Parker Rd, Aurora, CO 80014 ·{" "}
        <a href="tel:+17207630786">720-763-0786</a>
        <br />
        🏃 Pickup: Mon–Sat {formatWindow(pickupWins[1])} · Sun {formatWindow(pickupWins[0])}
        <br />
        🛵 Delivery: Mon–Sat {formatWindow(deliveryWins[1])} · Sun {formatWindow(deliveryWins[0])}
        <br />
        Aurora, Colorado · 100% Halal · Kabob, Turkish, Afghan Persian &amp; Middle Eastern
      </footer>
      )}

      {popupItem && (
        <DishPopup
          item={popupItem}
          photo={dishPhotos[popupItem.id] ?? popupItem.image}
          soldOut={unavailableSet.has(popupItem.id)}
          orderingClosed={orderingClosed}
          onClose={() => setPopupItem(null)}
          onAdd={(qty, options, instructions) => {
            // Capture the popup photo BEFORE the popup closes (it
            // unmounts right after onAdd) so it can fly to the bag bar.
            const img = document.querySelector<HTMLImageElement>(
              ".popup-card img.popup-photo"
            );
            addLine(popupItem, qty, options, instructions);
            flyToBag(img, dishPhotos[popupItem.id] ?? popupItem.image);
          }}
        />
      )}

      {itemCount > 0 && !showCheckout && (
        <>
          <div className="cart-bar">
            <span className="total">
              🛒 {itemCount} item{itemCount === 1 ? "" : "s"} · Subtotal {formatCents(subtotal)}
            </span>
            {orderingClosed ? (
              <span>🔴 Ordering closed</span>
            ) : (
              <button
                type="button"
                onClick={() => {
                  setShowCheckout(true);
                  setTimeout(() => document.getElementById("checkout")?.scrollIntoView({ behavior: "smooth" }), 50);
                }}
              >
                Checkout →
              </button>
            )}
          </div>
          <div className="cartbar-spacer" />
        </>
      )}

    </>
  );
}
