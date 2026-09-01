/**
 * Regression cover for the availability pill that gave no feedback when toggled.
 *
 * There is no behaviour to call here -- the fix is a class string on a server
 * component -- so this pins the two properties that actually broke:
 *
 *   1. The checked styling is driven by `has-[:checked]:`, i.e. by the live
 *      checkbox, so a toggle restyles the pill.
 *   2. Both availability forms use this one constant, so the next change cannot
 *      land in only one of them -- which is how both copies came to carry the
 *      same bug.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { AVAILABILITY_PILL_CLASS } from "./availability-pill";

const repoRoot = join(import.meta.dirname, "../../../..");
const readSource = (relative: string) => readFileSync(join(repoRoot, relative), "utf8");

const FORMS = [
  "src/app/(app)/schedule/page.tsx",
  "src/modules/schedule/components/attending-portal-section.tsx",
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

describe("both availability forms", () => {
  it.each(FORMS)("%s uses the shared pill class", (file) => {
    expect(readSource(file)).toContain("AVAILABILITY_PILL_CLASS");
  });

  /**
   * The exact shape of the bug: a ternary picking pill classes from a value
   * computed during the server render. If this reappears in either form, the
   * pill has stopped responding to clicks again.
   */
  it.each(FORMS)("%s no longer picks pill colours from the server-rendered value", (file) => {
    const source = readSource(file);
    expect(source).not.toMatch(/checked\s*\?\s*"border-brand/);
    expect(source).not.toContain('? "border-brand bg-brand/5 text-brand-fg font-semibold"');
  });
});
