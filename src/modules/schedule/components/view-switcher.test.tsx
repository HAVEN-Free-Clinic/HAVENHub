/**
 * ViewSwitcher is a pure render, so these are markup assertions.
 *
 * Honest note on what fails before this component existed: the behaviour cases
 * below could not fail against the old code, because the old code emitted this
 * exact markup -- twice, hand-rolled in builder-toolbar.tsx and
 * attending-toolbar.tsx. They pin the contract going forward (the 44px target,
 * the brand fill, the absence of an aria-label that e2e's exact-name locators
 * depend on) rather than proving the extraction.
 *
 * The one case that DID fail before is the last one, and it is a source-text
 * guard, not a behaviour test: two files in this directory carried the copied
 * nav class string.
 */
import { execSync } from "node:child_process";
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ViewSwitcher } from "./view-switcher";

const OPTIONS = [
  { value: "day", label: "Day" },
  { value: "grid", label: "Grid" },
  { value: "availability", label: "Availability" },
] as const;

function render(current: "day" | "grid" | "availability") {
  return renderToStaticMarkup(
    <ViewSwitcher options={OPTIONS} current={current} hrefFor={(v) => `/schedule/builder?view=${v}`} />,
  );
}

/** The opening tag of the anchor pointing at one view. */
function anchor(out: string, value: string): string {
  const match = out.match(new RegExp(`<a[^>]*href="[^"]*view=${value}"[^>]*>`));
  expect(match, `no anchor for view=${value}`).not.toBeNull();
  return match![0];
}

describe("ViewSwitcher", () => {
  it("renders one link per option, at the href the caller builds", () => {
    const out = render("grid");
    expect(out).toContain('href="/schedule/builder?view=day"');
    expect(out).toContain('href="/schedule/builder?view=grid"');
    expect(out).toContain('href="/schedule/builder?view=availability"');
  });

  it("marks the current view with aria-current, so the selection is not colour-only", () => {
    const out = render("grid");
    expect(anchor(out, "grid")).toContain('aria-current="page"');
    expect(anchor(out, "day")).not.toContain("aria-current");
  });

  it("paints only the current view with the brand fill", () => {
    const out = render("grid");
    expect(anchor(out, "grid")).toContain("bg-brand");
    expect(anchor(out, "day")).not.toContain("bg-brand");
    expect(anchor(out, "availability")).not.toContain("bg-brand");
  });

  /**
   * This is a primary toolbar control, not a dense tab row. Losing min-h-11
   * takes every option under the 44px target, which is the specific regression
   * that moving this onto TabRow's segmented variant would have caused.
   */
  it("keeps a 44px minimum target on every option", () => {
    const out = render("day");
    for (const value of ["day", "grid", "availability"]) {
      expect(anchor(out, value)).toContain("min-h-11");
    }
  });

  /**
   * e2e/schedule.spec.ts:618/:651/:672/:795 click these by
   * `getByRole("link", { name: "Grid", exact: true })`. An aria-label on the
   * link (which is how TabRow renders a count badge) would rename it and take
   * those four specs down.
   */
  it("leaves the links' accessible name as their visible text, with no aria-label override", () => {
    const out = render("grid");
    for (const value of ["day", "grid", "availability"]) {
      expect(anchor(out, value)).not.toContain("aria-label");
    }
    expect(out).toContain('aria-label="View"'); // the nav landmark still carries one
  });

  it("drops the divider on the leading option, so the row does not open with a stray rule", () => {
    expect(anchor(render("day"), "day")).toContain("first:border-l-0");
  });

  /**
   * Source-text guard, not a behaviour test. Before this component existed the
   * literal below appeared in builder-toolbar.tsx and attending-toolbar.tsx as
   * two independently maintained copies; this is what stops a third.
   *
   * Walks all of src, not just this directory. Scoped to the directory it could
   * only ever see siblings of the component, which is not where a third copy
   * would come from -- the page files that USE the row live under src/app, and
   * one of them already holds the string.
   */
  it("is the only View row in the app that spells its own classes", () => {
    const CONTAINER = "inline-flex overflow-hidden rounded-lg border border-border bg-surface";
    const offenders = execSync(
      `grep -rln --include='*.tsx' -F ${JSON.stringify(CONTAINER)} src`,
      { encoding: "utf8" },
    )
      .split("\n")
      .filter(Boolean)
      .filter((f) => !f.endsWith("view-switcher.tsx") && !f.endsWith("view-switcher.test.tsx"))
      // Not a View row: the builder's "Clicks assign" mode selector, a different
      // control that happens to sit in the same segmented container. Named here
      // rather than left invisible by a narrow scope -- if it is ever unified
      // with the View row, this line is what has to be deleted to do it.
      .filter((f) => f !== "src/app/(app)/schedule/builder/page.tsx");
    expect(offenders).toEqual([]);
  });
});
