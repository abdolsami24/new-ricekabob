// Client-side cart shape shared by the storefront, the top nav (item
// count badge) and the account page's "order again". The cart is an
// ARRAY of lines: the same dish with different options or instructions
// is a separate line. Prices are display-only here — the server
// recomputes everything at checkout from its own menu data.

import type { SelectedOption } from "./menuOptions";
import { optionsSignature } from "./menuOptions";

export const CART_KEY = "madinah_bakery_cart_v1";
export const CART_EVENT = "mb-cart-changed";

export interface CartLine {
  id: string;
  qty: number;
  options: SelectedOption[];
  instructions: string;
}

export function lineKey(line: CartLine): string {
  return `${line.id}||${optionsSignature(line.options)}||${line.instructions}`;
}

export function loadCart(): CartLine[] {
  try {
    const raw = localStorage.getItem(CART_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as CartLine[];
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((l) => l && typeof l.id === "string" && Number(l.qty) > 0)
      .map((l) => ({
        id: l.id,
        qty: Math.min(Math.floor(Number(l.qty)) || 1, 50),
        options: Array.isArray(l.options) ? l.options : [],
        instructions: typeof l.instructions === "string" ? l.instructions : "",
      }));
  } catch {
    return [];
  }
}

export function saveCart(lines: CartLine[]) {
  try {
    localStorage.setItem(CART_KEY, JSON.stringify(lines));
  } catch {
    /* ignore */
  }
  notifyCartChanged();
}

export function clearCart() {
  try {
    localStorage.removeItem(CART_KEY);
  } catch {
    /* ignore */
  }
  notifyCartChanged();
}

export function notifyCartChanged() {
  try {
    window.dispatchEvent(new Event(CART_EVENT));
  } catch {
    /* ignore */
  }
}

export function cartItemCount(lines: CartLine[]): number {
  return lines.reduce((s, l) => s + l.qty, 0);
}
