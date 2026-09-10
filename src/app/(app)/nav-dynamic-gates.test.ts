/**
 * The coverage guard for `dynamicGate` nav items.
 *
 * A tab marked `dynamicGate` is dropped by the global nav (and therefore by
 * Cmd+K, which builds its candidates from nav labels) unless the (app) layout
 * resolves it. Nothing used to notice when a module shipped a gated tab and
 * never wired a resolver: /recruitment/events and /volunteers/dual-roles sat
 * that way for their whole lives, reachable only by landing on the module first
 * and spotting the tab.
 *
 * The assertion is deliberately made against NAV_GATE_RESOLVERS rather than
 * against the modules' href constants. Both those constants already existed
 * while both tabs were invisible, so a guard built from constants would have
 * been green throughout the bug it is written for. NAV_GATE_RESOLVERS is what
 * the layout actually maps over, so an entry here IS a wired-up resolver.
 *
 * This test lives under src/app because src/platform may not import module
 * code, and the resolvers are module services.
 */
import { describe, expect, it } from "vitest";
import { MODULES } from "@/platform/modules/registry";
import { NAV_GATE_RESOLVERS } from "./nav-gates";

/**
 * Gated tabs the global nav is deliberately left blind to.
 *
 * /schedule/check-in gates on "is today a clinic day, and does this viewer have
 * a volunteer shift on it", which needs three queries (isClinicDayToday,
 * attendingForPerson, hasVolunteerShiftToday) that the request-cached
 * assignment context does NOT cover -- on every page in the app, to decide a
 * tab that is meaningful on roughly 30 days a year. The schedule layout keeps
 * deciding that one. Adding an href here is a cost decision; say why.
 */
const DELIBERATELY_UNRESOLVED = ["/schedule/check-in"];

const RESOLVED = new Set(NAV_GATE_RESOLVERS.flatMap((r) => r.hrefs));

describe("dynamicGate nav coverage", () => {
  it("resolves every gated tab the global nav is not deliberately blind to", () => {
    const unresolved = MODULES.flatMap((m) =>
      m.nav
        .filter((n) => n.dynamicGate && !RESOLVED.has(n.href) && !DELIBERATELY_UNRESOLVED.includes(n.href))
        .map((n) => `${m.id}:${n.href}`),
    );
    expect(unresolved).toEqual([]);
  });

  it("declares no resolver for an href no module actually gates", () => {
    // The mirror image: a resolver left behind after its tab was renamed or
    // un-gated would keep the guard above green while resolving nothing.
    const gated = new Set(MODULES.flatMap((m) => m.nav.filter((n) => n.dynamicGate).map((n) => n.href)));
    expect([...RESOLVED].filter((href) => !gated.has(href))).toEqual([]);
  });

  it("keeps /schedule/check-in out of the resolved set, so the cost note stays true", () => {
    for (const href of DELIBERATELY_UNRESOLVED) {
      expect(RESOLVED.has(href)).toBe(false);
    }
  });
});
