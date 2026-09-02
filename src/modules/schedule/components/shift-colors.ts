/**
 * The colour coding for a shift cell.
 *
 * A cell says two things at once: what ROLE someone is holding (volunteer,
 * shadow, director) and which SPECIAL SHIFT it is (triage, walk-in, care
 * coordinator, remote, specialty clinic). Both used to be one slate box with one
 * faint blue chip, so scanning a term for "who is on triage" meant reading
 * eighteen columns of 9px letters. Directors asked for this outright.
 *
 * Two facts, two channels, so neither has to win:
 *
 *   ROLE  -> the BORDER and the GLYPH, from the semantic tokens. Volunteer is
 *            brand (the app's "assigned" colour), shadow is warning (matching
 *            the amber Shadow mode already paints on the toolbar and the grid
 *            frame), director is success.
 *   TAG   -> the FILL, from the `--tag-*` hues in globals.css. A tag is a
 *            CATEGORY, not a status, so it deliberately does NOT reuse
 *            success/warning/critical -- a walk-in is not a warning.
 *
 * So a triage cell is pink whoever is standing in it, and a shadow is ringed in
 * amber whatever they are doing. An untagged cell falls back to its role's own
 * faint tint, which is what most of the grid is.
 *
 * Colour is never the only channel: every cell keeps its glyph letter and every
 * chip keeps its short code, so the grid reads identically to someone who cannot
 * separate the hues (WCAG 1.4.1). The hue is the scanning aid on top.
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

/**
 * Which tag wins the cell fill when an assignment carries more than one.
 *
 * The medical posts come first because they are what a director scans a term
 * for: "who is on triage on the 12th" is the question, and someone who is on
 * triage AND remote is on triage. Specialty clinic outranks remote for the same
 * reason -- it names a different clinic, where remote only modifies how the
 * shift is worked. Every tag still gets a chip, so nothing is lost by losing.
 */
const TAG_FILL_PRIORITY: readonly ShiftTagKey[] = [
  "triage",
  "walkin",
  "cc",
  "specialty",
  "remote",
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
 * Border and glyph colour per role, applied to every filled cell whatever it is
 * tagged with.
 *
 * The glyph is TEXT, so it takes `text-*-foreground` (4.5:1) and never the vivid
 * `text-success` / `text-warning`, which are tuned for 3:1 non-text and fail as
 * a 12px letter. The border is non-text, so it takes the vivid token at alpha.
 */
const ROLE_RING: Record<ShiftRole, string> = {
  DIRECTOR: "border-success/50 text-success-foreground",
  VOLUNTEER: "border-brand/35 text-brand-fg",
  SHADOW: "border-warning/55 text-warning-foreground",
};

/** Fill for a cell carrying no tag: the role's own faint tint. */
const ROLE_FILL: Record<ShiftRole, string> = {
  DIRECTOR: "bg-success/10",
  VOLUNTEER: "bg-brand-faint",
  SHADOW: "bg-warning/10",
};

/** Border + glyph colour for a filled cell of `role`. */
export function roleRingClasses(role: ShiftRole): string {
  return ROLE_RING[role];
}

/**
 * Background class for an UNTAGGED cell of `role`. A tagged cell takes
 * {@link tagCellStyle} instead, so the special shift owns the fill.
 */
export function roleFillClass(role: ShiftRole): string {
  return ROLE_FILL[role];
}

/**
 * The tag that colours the cell, or null when the assignment carries none.
 *
 * `allowed` is the tag set the surface actually displays -- the grid narrows it
 * to the department's own posts (`rolesForDept`). A tag nobody can see must not
 * silently paint the cell, or the fill becomes a colour with no key.
 */
export function primaryTag(
  tags: Record<ShiftTagKey, boolean>,
  allowed: readonly ShiftTagKey[] = SHIFT_TAG_KEYS,
): ShiftTagKey | null {
  return TAG_FILL_PRIORITY.find((t) => tags[t] && allowed.includes(t)) ?? null;
}

/**
 * Inline style for a tagged cell's fill.
 *
 * Returned as a style rather than a class because the hues live in `--tag-*`
 * custom properties, and Tailwind can only generate a utility for a class it can
 * see in the source. Same technique the module accent chips use. Sets the
 * background ALONE: the border stays the role's, which is what keeps both facts
 * on screen at once.
 */
export function tagCellStyle(tag: ShiftTagKey): CSSProperties {
  return { background: `var(--tag-${tag}-cell)` };
}

/** Inline style for one tag chip: its hue as the code, over its own chip step. */
export function tagChipStyle(tag: ShiftTagKey): CSSProperties {
  return { color: `var(--tag-${tag})`, background: `var(--tag-${tag}-chip)` };
}

/**
 * Inline style for the legend's tag swatch, which mimics a tagged cell: the cell
 * fill, ringed and lettered in the tag's own hue.
 */
export function tagSwatchStyle(tag: ShiftTagKey): CSSProperties {
  return {
    background: `var(--tag-${tag}-cell)`,
    color: `var(--tag-${tag})`,
    borderColor: `color-mix(in srgb, var(--tag-${tag}) 40%, transparent)`,
  };
}
