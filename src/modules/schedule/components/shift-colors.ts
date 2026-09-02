/**
 * The colour coding for a shift cell: what role it is, and which of the day's
 * roles the person is holding.
 *
 * The grid packs a role glyph and up to five tags into a ~52px cell, and every
 * one of them used to paint the same slate box with the same faint brand chip.
 * A director scanning a whole term for "who is shadowing" or "who is on triage"
 * had to read every 9px letter in eighteen columns, which is what directors
 * actually asked us to fix.
 *
 * Two families, deliberately kept apart:
 *
 *   - ROLE is a status the app already has vocabulary for, so it uses the
 *     semantic tokens: volunteer = brand (the app's "assigned" colour),
 *     shadow = warning (matching the amber the Shadow mode already paints on
 *     the toolbar and the grid frame), director = success.
 *   - TAG is a CATEGORY, not a status, so it deliberately does NOT reuse
 *     success/warning/critical -- a walk-in is not a warning. Tags get their own
 *     hue family (`--tag-*` in globals.css, same L/C discipline as the module
 *     accent hues), consumed through inline `style` so Tailwind's static scan
 *     never has to see a var it cannot enumerate.
 *
 * Colour is never the only channel: every cell keeps its glyph letter and every
 * chip keeps its short code, so the grid reads identically to someone who
 * cannot separate the hues (WCAG 1.4.1). The hue is the scanning aid on top.
 *
 * No "use client" here on purpose: both the server BuilderGrid and the client
 * BuilderCell import these, and a plain value exported from a client module
 * reaches a Server Component as a client-reference proxy rather than the value.
 */

import type { CSSProperties } from "react";
import type { ShiftRole } from "@prisma/client";

export type ShiftTagKey = "triage" | "walkin" | "cc" | "remote" | "specialty";

/** Canonical tag order. Matches the order the Day view offers the toggles in. */
export const SHIFT_TAG_KEYS: readonly ShiftTagKey[] = [
  "triage",
  "walkin",
  "cc",
  "remote",
  "specialty",
];

/** The letter shown in a grid cell for each role. */
export const ROLE_GLYPH: Record<ShiftRole, string> = {
  DIRECTOR: "D",
  VOLUNTEER: "V",
  SHADOW: "S",
};

export const ROLE_LABEL: Record<ShiftRole, string> = {
  DIRECTOR: "Director",
  VOLUNTEER: "Volunteer",
  SHADOW: "Shadow",
};

/** One-letter tag code. Shared by the grid cell and its legend. */
export const TAG_SHORT: Record<ShiftTagKey, string> = {
  triage: "T",
  walkin: "W",
  cc: "C",
  remote: "R",
  specialty: "S",
};

/** Spelled-out tag names, matching the calendar feed's wording. */
export const TAG_LABEL: Record<ShiftTagKey, string> = {
  triage: "Triage",
  walkin: "Walk-in",
  cc: "Care coordinator",
  remote: "Remote",
  specialty: "Specialty clinic",
};

/**
 * Cell classes per role: a faint tint, a matching border, and the glyph in the
 * *-foreground variant of the same family.
 *
 * The glyph is TEXT, so it takes `text-*-foreground` (4.5:1) and never the vivid
 * `text-success` / `text-warning`, which are tuned for 3:1 non-text and fail as
 * a 12px letter. The tint and the border are non-text, so they take the vivid
 * token at low alpha.
 */
const ROLE_FILL: Record<ShiftRole, string> = {
  DIRECTOR: "border-success/40 bg-success/10 text-success-foreground",
  VOLUNTEER: "border-brand/30 bg-brand-faint text-brand-fg",
  SHADOW: "border-warning/45 bg-warning/10 text-warning-foreground",
};

/** Tint + border + glyph colour for a filled cell of `role`. */
export function roleFillClasses(role: ShiftRole): string {
  return ROLE_FILL[role];
}

/**
 * Inline style for one tag chip: its hue as the text colour over the faint tint
 * of the same hue.
 *
 * Returned as a style rather than a class because the hues live in `--tag-*`
 * custom properties, and Tailwind can only generate a utility for a class it
 * can see in the source. Same technique the module accent chips use.
 */
export function tagChipStyle(tag: ShiftTagKey): CSSProperties {
  return { color: `var(--tag-${tag})`, background: `var(--tag-${tag}-bg)` };
}
