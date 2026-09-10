import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { MODULES } from "./registry";

/**
 * Guards one rule: a module nav label and the H1 of the page it points at are
 * the same name.
 *
 * Two surfaces make this load-bearing rather than cosmetic. buildBreadcrumbs
 * (src/platform/ui/breadcrumb-trail.ts) renders the registry label as the
 * current crumb, so a divergence prints two names for one page a single line
 * apart. And matchPages (src/platform/search/match.ts) scores only the nav
 * label and the module-qualified form of it, so a page whose H1 shares no
 * words with its label cannot be found in Cmd+K by the name printed on it.
 *
 * The rule: the page's first PageHeader title must equal the nav label, or
 * equal "<module title> <nav label>" (the module-qualified form matchPages
 * already composes, e.g. Recruitment + Cycles -> "Recruitment cycles").
 *
 * This reads the page file rather than rendering it, in the style of
 * src/platform/dates/no-raw-locale.guard.test.ts.
 */

/**
 * Pages whose H1 cannot be a fixed string, with the reason. Keep this list
 * short and keep the reason with the entry: an exemption without one is how a
 * guard quietly stops guarding.
 */
const EXEMPT: Record<string, string> = {
  // Data-driven title: "Check in for <date>" (:129), "No clinic today" (:102)
  // or "You are checked in" (:123), depending on the day and the viewer.
  "/schedule/check-in": "title varies by clinic date and check-in state",
  // page.tsx renders no PageHeader at all; the H1 lives in
  // src/modules/clinic/avs/avs-tool.tsx:107 and already reads "After Visit
  // Summary", matching the label.
  "/clinic/avs": "H1 lives in the client tool component, not page.tsx",
};

describe("a module nav label is the page's own H1", () => {
  it("has no nav item whose page prints a different name", () => {
    const offenders: string[] = [];

    for (const mod of MODULES) {
      for (const item of mod.nav) {
        if (EXEMPT[item.href]) continue;
        const file = `src/app/(app)${item.href}/page.tsx`;
        if (!existsSync(file)) {
          offenders.push(`${item.href}: no ${file} (add an exemption with a reason)`);
          continue;
        }
        const src = readFileSync(file, "utf8");
        const m = /<PageHeader\b[^>]*?\btitle="([^"]+)"/s.exec(src);
        if (!m) {
          offenders.push(`${item.href}: no literal PageHeader title found`);
          continue;
        }
        const h1 = m[1];
        const ok =
          h1.toLowerCase() === item.label.toLowerCase() ||
          h1.toLowerCase() === `${mod.title} ${item.label}`.toLowerCase();
        if (!ok) offenders.push(`${item.href}: nav "${item.label}" vs H1 "${h1}"`);
      }
    }

    expect(offenders).toEqual([]);
  });
});
