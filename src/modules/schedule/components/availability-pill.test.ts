/**
 * Regression cover for the availability pill that gave no feedback when toggled.
 *
 * There is no behaviour to call here -- the fix is a class string on a server
 * component -- so this pins the two properties that actually broke:
 *
 *   1. The checked styling is driven by `has-[:checked]:`, i.e. by the live
 *      checkbox, so a toggle restyles the pill.
 *   2. Every availability form uses these constants, so the next change cannot
 *      land in only some of them -- which is how the copies came to carry the
 *      same bug, and how the builder kept it after the other two were fixed.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  AVAILABILITY_PILL_CLASS,
  BUILDER_AVAILABILITY_PILL_CLASS,
  builderReadOnlyPillClass,
} from "./availability-pill";

const repoRoot = join(import.meta.dirname, "../../../..");
const readSource = (relative: string) => readFileSync(join(repoRoot, relative), "utf8");

/**
 * Every file rendering a clinic-date pill with a checkbox in it.
 *
 * The builder was missing from this list, which is exactly how it kept the bug
 * for the two weeks after the other two were fixed. Adding a fourth form means
 * adding it here.
 */
const FORMS = [
  "src/app/(app)/schedule/page.tsx",
  "src/modules/schedule/components/attending-portal-section.tsx",
  "src/modules/schedule/components/builder-availability-view.tsx",
];

describe("AVAILABILITY_PILL_CLASS", () => {
  it("styles the checked state from the live checkbox, not a server value", () => {
    // The whole bug: without these, the pill keeps whatever colour the server
    // rendered and a member sees nothing happen when they click a date.
    expect(AVAILABILITY_PILL_CLASS).toContain("has-[:checked]:border-brand");
    expect(AVAILABILITY_PILL_CLASS).toContain("has-[:checked]:bg-brand/5");
    expect(AVAILABILITY_PILL_CLASS).toContain("has-[:checked]:text-brand-fg");
    expect(AVAILABILITY_PILL_CLASS).toContain("has-[:checked]:font-semibold");
  });

  it("keeps a resting state to change away from", () => {
    expect(AVAILABILITY_PILL_CLASS).toContain("border-border");
    expect(AVAILABILITY_PILL_CLASS).toContain("text-muted-foreground");
  });

  it("keeps the 44px touch target the pill already had", () => {
    expect(AVAILABILITY_PILL_CLASS).toContain("min-h-11");
  });

  it("gives keyboard users a ring on the pill, not just the 16px box", () => {
    expect(AVAILABILITY_PILL_CLASS).toContain("has-[:focus-visible]:outline-brand");
  });
});

describe("BUILDER_AVAILABILITY_PILL_CLASS", () => {
  it("gets the same live checked state as the member pill", () => {
    // The builder kept the server-value ternary for two weeks after the member
    // and attending forms were fixed. Same behaviour or it is not fixed.
    expect(BUILDER_AVAILABILITY_PILL_CLASS).toContain("has-[:checked]:border-brand");
    expect(BUILDER_AVAILABILITY_PILL_CLASS).toContain("has-[:checked]:bg-brand/5");
    expect(BUILDER_AVAILABILITY_PILL_CLASS).toContain("has-[:checked]:text-brand-fg");
    expect(BUILDER_AVAILABILITY_PILL_CLASS).toContain("has-[:checked]:font-semibold");
    expect(BUILDER_AVAILABILITY_PILL_CLASS).toContain("has-[:focus-visible]:outline-brand");
  });

  it("keeps a resting state to change away from", () => {
    expect(BUILDER_AVAILABILITY_PILL_CLASS).toContain("border-border");
    expect(BUILDER_AVAILABILITY_PILL_CLASS).toContain("text-muted-foreground");
  });

  it("stays compact: the builder grid is every date for every member", () => {
    // Deliberately NOT min-h-11. If this ever gains it, the director view grew
    // by a screen or two and that should be a decision, not a copy-paste.
    expect(BUILDER_AVAILABILITY_PILL_CLASS).not.toContain("min-h-11");
    expect(BUILDER_AVAILABILITY_PILL_CLASS).toContain("px-2.5 py-1");
  });
});

describe("builderReadOnlyPillClass", () => {
  /**
   * The one place a server value legitimately drives the colour: an archived
   * term renders no checkbox, so there is no live state to read.
   */
  it("marks an available date without any live-state classes", () => {
    const available = builderReadOnlyPillClass(true);
    expect(available).toContain("border-brand");
    expect(available).not.toContain("has-[:checked]");
  });

  it("leaves an unavailable date in the resting palette", () => {
    const unavailable = builderReadOnlyPillClass(false);
    expect(unavailable).toContain("text-muted-foreground");
    expect(unavailable).not.toContain("border-brand");
  });

  it("is not clickable, so it must not claim to be", () => {
    expect(builderReadOnlyPillClass(true)).not.toContain("cursor-pointer");
  });
});

describe("every availability form", () => {
  it.each(FORMS)("%s uses the shared pill class", (file) => {
    expect(readSource(file)).toContain("AVAILABILITY_PILL_CLASS");
  });

  /**
   * The exact shape of the bug: a ternary picking pill classes from a value
   * computed during the server render. If this reappears in any form, that
   * pill has stopped responding to clicks again.
   *
   * The builder's archived-term pill is genuinely server-driven, which is why
   * that ternary lives in availability-pill.ts behind
   * `builderReadOnlyPillClass` -- the only file exempt from this rule is the one
   * defining it.
   */
  it.each(FORMS)("%s no longer picks pill colours from the server-rendered value", (file) => {
    const source = readSource(file);
    expect(source).not.toMatch(/checked\s*\?\s*"border-brand/);
    expect(source).not.toContain('? "border-brand bg-brand/5 text-brand-fg font-semibold"');
  });
});
