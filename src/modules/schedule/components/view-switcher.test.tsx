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
import { existsSync, readFileSync } from "node:fs";
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
   * Scoped to the whole repo, not to this directory. A directory walk reported
   * clean while a third live copy sat one folder away in the schedule ROUTES,
   * which is the one thing a guard must never do.
   */
  const CONTAINER = "inline-flex overflow-hidden rounded-lg border border-border bg-surface";

  /** Files that spell the container but are NOT a copy of this switcher. */
  const EXEMPT: Record<string, string> = {
    // The builder's "Clicks assign" mode switcher. Same container, genuinely
    // different control: its second option is warning-toned with its own border
    // and background (assigning a Shadow is a different act from assigning a
    // volunteer, and the row says so), where ViewSwitcher's options are a
    // uniform brand/muted pair. Folding it in would need a per-option tone prop
    // that exactly one caller would ever pass.
    "src/app/(app)/schedule/builder/page.tsx": "mode switcher, per-option tone",
  };

  it("is the only file in the repo that spells the View row's own classes", () => {
    const offenders = execSync("git ls-files 'src/**/*.tsx'", { encoding: "utf8" })
      .split("\n")
      .filter(Boolean)
      .filter((f) => !f.endsWith(".test.tsx"))
      .filter((f) => f !== "src/modules/schedule/components/view-switcher.tsx")
      .filter((f) => !EXEMPT[f])
      .filter((f) => existsSync(f) && readFileSync(f, "utf8").includes(CONTAINER));
    expect(offenders).toEqual([]);
  });

  it("still sees the exempted file, so the exemption cannot go stale", () => {
    // If the builder ever stops spelling the container, the entry above is dead
    // and should go rather than sit there implying a copy still exists.
    for (const f of Object.keys(EXEMPT)) {
      expect(readFileSync(f, "utf8"), f).toContain(CONTAINER);
    }
  });
});
