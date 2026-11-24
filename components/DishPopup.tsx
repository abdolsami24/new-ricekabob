"use client";

// Dish options popup: the dish's additional-option groups as checkboxes
// (all optional; most groups are multi-select, groups flagged `single`
// are pick-one), a quantity stepper and a special instructions box.
// Choices flagged `hide_price` show no price on their line — their price
// appears only in the Add-button total. The Add button shows the live
// total — base price plus the chosen options, times quantity. Prices
// shown here are for display; the server re-prices everything at
// checkout.

import { useMemo, useState } from "react";
import { formatCents, type MenuItem, type SelectedOption } from "@/lib/menu";

export default function DishPopup({
  item,
  photo,
  soldOut,
  orderingClosed,
  onClose,
  onAdd,
}: {
  item: MenuItem;
  photo: string;
  soldOut: boolean;
  orderingClosed: boolean;
  onClose: () => void;
  onAdd: (qty: number, options: SelectedOption[], instructions: string) => void;
}) {
  const [qty, setQty] = useState(1);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [instructions, setInstructions] = useState("");

  const chosen: SelectedOption[] = useMemo(() => {
    const out: SelectedOption[] = [];
    for (const g of item.option_groups ?? []) {
      for (const c of g.choices) {
        if (selected.has(`${g.name}::${c.name}`)) {
          out.push({ group: g.name, name: c.name, price_delta_cents: c.price_delta_cents });
        }
      }
    }
    return out;
  }, [selected, item]);

  const unitTotal =
    item.price_cents + chosen.reduce((s, o) => s + o.price_delta_cents, 0);

  function toggle(group: string, name: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      const key = `${group}::${name}`;
      if (next.has(key)) {
        next.delete(key);
      } else {
        // Pick-one groups: selecting a choice clears the group's others.
        const g = (item.option_groups ?? []).find((x) => x.name === group);
        if (g?.single) {
          for (const c of g.choices) next.delete(`${group}::${c.name}`);
        }
        next.add(key);
      }
      return next;
    });
  }

  return (
    <div className="popup-overlay" onClick={onClose} role="presentation">
      <div
        className="popup-card"
        role="dialog"
        aria-modal="true"
        aria-label={item.name}
        onClick={(e) => e.stopPropagation()}
      >
        <button type="button" className="popup-close" onClick={onClose} aria-label="Close">
          ✕
        </button>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={photo} alt={item.name} className="popup-photo" />
        <div className="popup-body">
          <h3>
            {item.number && <span className="num">{item.number}</span>}
            {item.name}
          </h3>
          <p className="popup-desc">{item.description}</p>

          {(item.option_groups ?? []).map((g) => (
            <fieldset className="opt-group" key={g.name}>
              <legend>{g.name}</legend>
              {g.choices.map((c) => {
                const key = `${g.name}::${c.name}`;
                return (
                  <label className="opt-row" key={key}>
                    <input
                      type="checkbox"
                      checked={selected.has(key)}
                      onChange={() => toggle(g.name, c.name)}
                    />
                    <span className="opt-name">{c.name}</span>
                    {!c.hide_price && (
                      <span className="opt-price">
                        {c.price_delta_cents > 0
                          ? `+${formatCents(c.price_delta_cents)}`
                          : "Free"}
                      </span>
                    )}
                  </label>
                );
              })}
            </fieldset>
          ))}

          <div className="field">
            <label htmlFor="dish-note">Special instructions (optional)</label>
            <textarea
              id="dish-note"
              rows={2}
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
              placeholder="e.g. extra spicy, sauce on the side"
              maxLength={200}
            />
          </div>

          <div className="popup-actions">
            <span className="qty-controls big">
              <button
                type="button"
                onClick={() => setQty((q) => Math.max(1, q - 1))}
                aria-label="One less"
              >
                −
              </button>
              <span className="count">{qty}</span>
              <button
                type="button"
                onClick={() => setQty((q) => Math.min(50, q + 1))}
                aria-label="One more"
              >
                +
              </button>
            </span>
            <button
              type="button"
              className="add-btn popup-add"
              disabled={soldOut || orderingClosed}
              onClick={() => {
                onAdd(qty, chosen, instructions.trim());
                onClose();
              }}
            >
              {soldOut
                ? "Sold out"
                : orderingClosed
                  ? "Ordering closed"
                  : `Add to Cart — ${formatCents(unitTotal * qty)}`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
