"use client";

// Shared header for the customer pages (Home, Menu, Deals, Rewards,
// Visit, Account): a thin info bar over a deep-green "stage" header with
// the brand, pill navigation and a saffron bag button — mirroring the
// reference site's WebHeader. Hidden on the staff screens (/kitchen,
// /display, /admin) which are full-screen apps of their own.

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { CART_EVENT, loadCart, cartItemCount } from "@/lib/cartClient";

const LINKS = [
  { href: "/", label: "Home" },
  { href: "/menu", label: "Menu" },
  { href: "/deals", label: "Deals" },
  { href: "/rewards", label: "Rewards" },
  { href: "/visit", label: "Visit" },
  { href: "/account", label: "Account" },
  { href: "/track", label: "Track order" },
];

export default function TopNav() {
  const pathname = usePathname();
  const [count, setCount] = useState(0);
  const [subtotalCents, setSubtotalCents] = useState(0);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const update = () => {
      setCount(cartItemCount(loadCart()));
      try {
        setSubtotalCents(
          Number(localStorage.getItem("mm_cart_subtotal_cents") || 0)
        );
      } catch {
        setSubtotalCents(0);
      }
    };
    update();
    window.addEventListener(CART_EVENT, update);
    window.addEventListener("storage", update);
    return () => {
      window.removeEventListener(CART_EVENT, update);
      window.removeEventListener("storage", update);
    };
  }, [pathname]);

  // Close the mobile menu whenever the page changes.
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  if (
    pathname?.startsWith("/kitchen") ||
    pathname?.startsWith("/display") ||
    pathname?.startsWith("/admin")
  ) {
    return null;
  }

  return (
    <>
      <div className="topbar">
        <span>📍 3126 S Parker Rd, Aurora, CO 80014</span>
        <a href="tel:+17207630786">📞 720-763-0786</a>
        <span>🕙 Pickup: Mon–Sat 10–7:45 · Sun 10–6:45</span>
      </div>
      <header className="site-header">
        <div className="header-inner">
          <Link href="/" className="brand">
            <h1>
              Madinah <span className="gold">Market</span>
            </h1>
            <span className="brand-sub">Aurora, Colorado · 100% halal</span>
          </Link>
          <span className="halal-badge">100% HALAL</span>
          <span className="header-spacer" />
          {pathname === "/menu" && count > 0 ? (
            <button
              type="button"
              className="bag-btn"
              onClick={() =>
                window.dispatchEvent(new CustomEvent("mm:open-checkout"))
              }
            >
              🛒 Cart · {count}
              {subtotalCents > 0 ? ` · $${(subtotalCents / 100).toFixed(2)}` : ""}
            </button>
          ) : (
            <Link href="/menu" className="bag-btn">
              🛒{" "}
              {count > 0
                ? `Cart · ${count}${subtotalCents > 0 ? ` · $${(subtotalCents / 100).toFixed(2)}` : ""}`
                : "Order now"}
            </Link>
          )}
          <button
            type="button"
            className="nav-toggle"
            aria-label={open ? "Close menu" : "Open menu"}
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
          >
            {open ? "✕" : "☰"}
          </button>
          <nav className={open ? "main-nav open" : "main-nav"} aria-label="Main">
            {LINKS.map((l) => (
              <Link
                key={l.href}
                href={l.href}
                className={pathname === l.href ? "active" : ""}
              >
                {l.label}
              </Link>
            ))}
          </nav>
        </div>
      </header>
    </>
  );
}
