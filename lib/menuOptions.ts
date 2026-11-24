// Per-item additional options, copied exactly from the restaurant's
// existing online menu (GloriaFood / denverhalal.com) — see
// menu-import.json (format madinah-menu-import/v1) at the project root.
//
// Groups are optional. Most are multi-select (checkboxes); a group with
// `single: true` is pick-one (the popup deselects the group's other
// choices). A choice with `hide_price: true` shows no price on its popup
// line — its price appears only in the popup's Add-button total (the
// "Meal Deal" choices). A choice is identified by its (group name,
// choice name) pair; prices are integer cents added to the dish's base
// price. The server (lib/pricing.ts) re-validates every selection
// against this data — browser-sent prices for options are never trusted.

import menuImport from "../menu-import.json";

export interface OptionChoice {
  name: string;
  price_delta_cents: number;
  /** Display only: hide this choice's price on its popup line. */
  hide_price?: boolean;
}

export interface OptionGroup {
  name: string;
  /** Pick-one group: selecting a choice deselects the group's others. */
  single?: boolean;
  choices: OptionChoice[];
}

/** A customer's chosen option, as stored on cart lines and orders. */
export interface SelectedOption {
  group: string;
  name: string;
  price_delta_cents: number;
}

interface ImportItem {
  id: string;
  option_groups?: {
    name: string;
    single?: boolean;
    choices: (OptionChoice & { hide_price?: boolean })[];
  }[];
}

const items = (menuImport as { items: ImportItem[] }).items ?? [];

/** Built-in option groups per menu item id (22 of the 40 dishes). */
export const OPTION_GROUPS_BY_ID: Record<string, OptionGroup[]> = {};
for (const it of items) {
  if (it.option_groups && it.option_groups.length > 0) {
    OPTION_GROUPS_BY_ID[it.id] = it.option_groups.map((g) => ({
      name: g.name,
      ...(g.single ? { single: true } : {}),
      choices: g.choices.map((c) => ({
        name: c.name,
        price_delta_cents: c.price_delta_cents,
        ...(c.hide_price ? { hide_price: true } : {}),
      })),
    }));
  }
}

/** Normalizes option groups coming from the database (jsonb). */
export function sanitizeOptionGroups(raw: unknown): OptionGroup[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const groups: OptionGroup[] = [];
  for (const g of raw as Record<string, unknown>[]) {
    if (!g || typeof g.name !== "string" || !Array.isArray(g.choices)) continue;
    const choices: OptionChoice[] = [];
    for (const c of g.choices as Record<string, unknown>[]) {
      if (!c || typeof c.name !== "string") continue;
      const delta = Math.floor(Number(c.price_delta_cents));
      choices.push({
        name: c.name,
        price_delta_cents: Number.isFinite(delta) ? delta : 0,
        ...(c.hide_price === true ? { hide_price: true } : {}),
      });
    }
    if (choices.length > 0) {
      groups.push({
        name: g.name,
        ...(g.single === true ? { single: true } : {}),
        choices,
      });
    }
  }
  if (groups.length > 0) return groups;
  // An explicitly stored EMPTY array means "staff removed every option"
  // (the admin options editor saves [] then) and must NOT fall back to
  // the built-in groups. A non-empty value that sanitizes to nothing is
  // treated as missing, exactly as before.
  return raw.length === 0 ? [] : undefined;
}

// ---- Admin options editor ---------------------------------------------------
// The panel editor sends groups in a dollars-based wire shape:
//   [{ name, single?, choices: [{ name, price, hide_price? }] }]
// where `price` is the DOLLARS amount the staff member typed. Saving is
// STRICT (unlike sanitizeOptionGroups above, the lenient read path): any
// problem rejects the whole save with a clear message, so a bad edit can
// never partially land or break storefront pricing.

export const MAX_OPTION_GROUPS = 10;
export const MAX_OPTION_CHOICES_PER_DISH = 30;
export const MAX_CHOICE_PRICE_DOLLARS = 999.99;

/**
 * Validates editor-sent option groups and returns them in the stored
 * OptionGroup shape (integer cents, flags present only when true,
 * unknown fields stripped). Throws an Error with a staff-readable
 * message on the first problem found.
 */
export function validateEditorOptionGroups(raw: unknown): OptionGroup[] {
  if (!Array.isArray(raw)) {
    throw new Error("Options must be a list of groups.");
  }
  if (raw.length > MAX_OPTION_GROUPS) {
    throw new Error(`A dish can have at most ${MAX_OPTION_GROUPS} option groups.`);
  }
  const groups: OptionGroup[] = [];
  const groupNames = new Set<string>();
  let totalChoices = 0;
  for (const g of raw as Record<string, unknown>[]) {
    if (!g || typeof g !== "object") {
      throw new Error("An option group is malformed.");
    }
    const name = typeof g.name === "string" ? g.name.trim() : "";
    if (!name) throw new Error("Every option group needs a name.");
    if (name.length > 60) {
      throw new Error(`Group name "${name}" is too long (60 characters max).`);
    }
    if (groupNames.has(name)) {
      throw new Error(
        `Two option groups are named "${name}" — group names must be unique per dish.`
      );
    }
    groupNames.add(name);
    if (!Array.isArray(g.choices) || g.choices.length === 0) {
      throw new Error(
        `Group "${name}" needs at least one choice — add one or delete the group.`
      );
    }
    const choices: OptionChoice[] = [];
    const choiceNames = new Set<string>();
    for (const c of g.choices as Record<string, unknown>[]) {
      if (!c || typeof c !== "object") {
        throw new Error(`A choice in group "${name}" is malformed.`);
      }
      const choiceName = typeof c.name === "string" ? c.name.trim() : "";
      if (!choiceName) {
        throw new Error(`Every choice in group "${name}" needs a name.`);
      }
      if (choiceName.length > 120) {
        throw new Error(`Choice name "${choiceName}" is too long (120 characters max).`);
      }
      if (choiceNames.has(choiceName)) {
        throw new Error(`Group "${name}" has two choices named "${choiceName}".`);
      }
      choiceNames.add(choiceName);
      const dollars = typeof c.price === "number" ? c.price : NaN;
      if (!Number.isFinite(dollars)) {
        throw new Error(`Enter a valid price for "${choiceName}" in group "${name}".`);
      }
      if (dollars < 0) {
        throw new Error(`The price for "${choiceName}" cannot be negative.`);
      }
      if (dollars > MAX_CHOICE_PRICE_DOLLARS) {
        throw new Error(
          `The price for "${choiceName}" is too high (max $${MAX_CHOICE_PRICE_DOLLARS}).`
        );
      }
      totalChoices += 1;
      if (totalChoices > MAX_OPTION_CHOICES_PER_DISH) {
        throw new Error(
          `A dish can have at most ${MAX_OPTION_CHOICES_PER_DISH} choices in total.`
        );
      }
      choices.push({
        name: choiceName,
        price_delta_cents: Math.round(dollars * 100),
        ...(c.hide_price === true ? { hide_price: true } : {}),
      });
    }
    groups.push({
      name,
      ...(g.single === true ? { single: true } : {}),
      choices,
    });
  }
  return groups;
}

/**
 * Validates client-sent option selections against an item's trusted
 * option groups. Returns the trusted selections (with server prices),
 * or null when anything is unknown/duplicated — callers must reject.
 */
export function validateSelectedOptions(
  groups: OptionGroup[] | undefined,
  requested: unknown
): SelectedOption[] | null {
  if (requested === undefined || requested === null) return [];
  if (!Array.isArray(requested)) return null;
  if (requested.length > 30) return null;
  const out: SelectedOption[] = [];
  const seen = new Set<string>();
  for (const raw of requested as Record<string, unknown>[]) {
    const group = String(raw?.group ?? "");
    const name = String(raw?.name ?? "");
    const key = `${group}::${name}`;
    if (seen.has(key)) return null;
    seen.add(key);
    const g = (groups ?? []).find((x) => x.name === group);
    const choice = g?.choices.find((x) => x.name === name);
    if (!choice) return null;
    out.push({ group, name, price_delta_cents: choice.price_delta_cents });
  }
  return out;
}

/** Stable signature so identical option sets merge into one cart line. */
export function optionsSignature(options: SelectedOption[]): string {
  return options
    .map((o) => `${o.group}::${o.name}`)
    .sort()
    .join("|");
}
