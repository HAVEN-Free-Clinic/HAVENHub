import { describe, expect, it } from "vitest";
import { MODULES } from "./registry";
import { filterNavItems } from "./access";

describe("module registry", () => {
  it("has unique module ids", () => {
    const ids = MODULES.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("namespaces every permission by its module id", () => {
    for (const m of MODULES) {
      for (const p of m.permissions) {
        expect(p.startsWith(`${m.id}.`)).toBe(true);
      }
    }
  });

  it("includes each module's accessPermission in its declared permissions when defined", () => {
    for (const m of MODULES) {
      // accessPermission is optional: modules open to any signed-in person
      // (e.g. my-info) declare no accessPermission and may have no permissions.
      if (m.accessPermission !== undefined) {
        expect(m.permissions).toContain(m.accessPermission);
      }
    }
  });

  it("does not expose the dead 'recruitment.review' permission (issue #92)", () => {
    // recruitment.review is never passed to can()/requirePermission anywhere;
    // reviewer access is driven solely by recruitment.review_all (SRR) and
    // active-term DIRECTOR department scope. A grantable-but-unchecked permission
    // is misleading in the role editor, so it must not be declared. review_all stays.
    const all = MODULES.flatMap((m) => m.permissions);
    expect(all).not.toContain("recruitment.review");
    expect(all).toContain("recruitment.review_all");
  });

  it("registers all known modules", () => {
    expect(MODULES.map((m) => m.id).sort()).toEqual(
      [
        "admin",
        "clinic",
        "incidents",
        "learning",
        "my-info",
        "outreach",
        "recruitment",
        "schedule",
        "support",
        "volunteers",
      ].sort()
    );
  });

  it("no longer declares the pre-delegation campaign permission", () => {
    const all = MODULES.flatMap((m) => m.permissions);
    expect(all).not.toContain("admin.send_email_campaign");
    expect(all).toContain("outreach.send_unrestricted");
  });

  it("keeps every nav-row module title short", () => {
    // Deliberately a per-title cap, NOT a whole-row width budget.
    //
    // An earlier version of this test summed the row's characters against a
    // pixel budget and passed while the row actually overflowed, because
    // character count is a poor proxy: measured in CI, "Admin" (5 chars) renders
    // 45px while "Clinic" (6 chars) renders 38px, and the budget also predated
    // the per-module chevrons, which add real width the count cannot see.
    //
    // The row fitting on a laptop is a layout property, so it is asserted where
    // layout actually exists: e2e/global-nav.spec.ts drives a real browser at
    // 1280px and fails if anything is pushed behind "More". This test only
    // guards the input that test cannot: a single overlong title.
    const rowTitles = MODULES.filter((m) => m.status === "active" && !m.personal).map((m) => m.title);
    for (const title of rowTitles) {
      expect(title.length, `module title "${title}" is too long for the nav row`).toBeLessThanOrEqual(12);
    }
  });

  it("marks every schedule tab whose real gate is data-driven with dynamicGate", () => {
    // Builder, Approvals and Attendings are dropped by schedule/layout.tsx from
    // the module tab row using capability checks (canManageAnyScheduleDept,
    // manageableRequestDepartmentIds, canManageAnyAttendingRoster) that no permission
    // string can express. Without dynamicGate the global nav's Schedule dropdown
    // offers all three to any schedule.view holder -- and every seeded volunteer
    // role holds schedule.view -- so the links bounce to /no-access. Losing the
    // marker silently reintroduces those dead ends, hence this assertion.
    //
    // Check in joins them for a different reason: its gate (isClinicDayToday)
    // is a calendar fact, not a permission, so the global dropdown still can't
    // resolve it -- offering the tab on a non-clinic day would land on a page
    // with nothing to do, not /no-access, but the marker is the same mechanism.
    //
    // Coverage is Attendings' read-only twin on a wider gate (schedule.edit_all
    // OR schedule.manage_attendings). "Either of two permissions" is not a
    // permission string either, so it carries the marker for the same reason.
    const schedule = MODULES.find((m) => m.id === "schedule")!;
    const gated = schedule.nav.filter((n) => n.dynamicGate).map((n) => n.href);
    expect(gated.sort()).toEqual(
      [
        "/schedule/builder",
        "/schedule/requests",
        "/schedule/attendings",
        // Credentialing rides Attendings' gate exactly (canManageAttendings).
        // It matters MORE than the others that it carries the marker: the
        // schedule layout's own filter list is deliberately non-exhaustive, so
        // an href it does not name falls through to every schedule.view holder.
        "/schedule/attendings/credentialing",
        "/schedule/coverage",
        "/schedule/check-in",
      ].sort(),
    );
  });

  it("folds a page only under a real, unfolded tab of its own module", () => {
    // ModuleNav marks `underTab` active on a folded page. An href that names no
    // tab -- a typo, a tab since renamed, a folded page, another module -- would
    // light nothing, and the section you are in would silently vanish from the row.
    for (const m of MODULES) {
      const tabs = new Set(m.nav.filter((n) => !n.underTab).map((n) => n.href));
      for (const n of m.nav.filter((n) => n.underTab)) {
        expect(tabs.has(n.underTab!), `${m.id} "${n.label}" folds under ${n.underTab}, which is not a tab`).toBe(true);
      }
    }
  });

  it("uses dynamicGate only where a gate genuinely is not a permission string", () => {
    // The global nav is deliberately under-inclusive for these and only these:
    // every other tab must stay resolvable from permissions alone, or the
    // dropdown quietly stops offering links it could safely offer.
    //
    // Recruitment's Events tab joins the schedule set because its gate is
    // canRecordAttendance -- recruitment.record_attendance OR manage_cycles OR
    // review_all OR a department director's review scope. The scope half is
    // data-driven (manageableDepartmentIds), so no permission string, and no
    // array of them, expresses it.
    const gated = MODULES.flatMap((m) =>
      m.nav.filter((n) => n.dynamicGate).map((n) => `${m.id}:${n.href}`),
    );
    //
    // Volunteers' Dual roles tab joins them for the same kind of reason: its
    // gate is "directs a department that can RECEIVE a dual-role offer". Every
    // director holds volunteers.manage_dual_roles, but only the departments that
    // ask the dual-role question on the application can ever have a queue, so
    // the permission alone would offer the tab to every director in the clinic
    // and land nearly all of them on an empty page. Which departments those are
    // is data (a Department row), not a permission.
    expect(gated.filter((h) => !h.startsWith("schedule:"))).toEqual([
      "volunteers:/volunteers/dual-roles",
      "recruitment:/recruitment/events",
    ]);
  });

  it("offers a support view-only auditor the All requests tab but not the Epic tools tab", () => {
    // The Epic / YNHH tab is the one destructive surface in the module (it
    // generates and submits access requests), so the read-only grant must never
    // reach it. Asserting both halves here keeps the two tabs from being
    // widened together by a careless edit to the manifest.
    const support = MODULES.find((m) => m.id === "support")!;
    const labels = filterNavItems(support.nav, new Set(["support.view_all_requests"])).map(
      (i) => i.label
    );
    expect(labels).toContain("All requests");
    expect(labels).not.toContain("Epic requests");
  });

  it("puts no permission on Approvals, whose real gate is wider than any permission", () => {
    // The page admits anyone with an ACTIVE DIRECTOR TermMembership, via
    // manageableRequestDepartmentIds -> manageableDepartmentIds, which needs no
    // permission at all. A `permission` here is applied by filterNavItems BEFORE
    // the layout's data-driven canApprove check, and filterNavItems can only
    // REMOVE -- so any permission string on this item hides the tab from every
    // director, and canApprove never gets the chance to put it back.
    //
    // That is not hypothetical: it shipped that way. Directors were emailed a
    // daily link to /schedule/requests and shown a dashboard "Approvals" card,
    // both computed from the same permission-free authority the page uses, while
    // the tab row, the Schedule dropdown and Cmd+K all denied the destination.
    const schedule = MODULES.find((m) => m.id === "schedule")!;
    const approvals = schedule.nav.find((n) => n.href === "/schedule/requests")!;
    expect(approvals).toBeDefined();
    expect(approvals.permission).toBeUndefined();
    // dynamicGate is what keeps it honest without one: the global nav omits it
    // unless a caller resolves the gate, and the layout applies canApprove.
    expect(approvals.dynamicGate).toBe(true);
  });

  it("gives the onboarding contract editor a nav entry so it is not orphaned", () => {
    // In Recruitment now, beside the cycles whose contracts start from it.
    const recruitment = MODULES.find((m) => m.id === "recruitment")!;
    expect(recruitment.nav.map((n) => n.href)).toContain("/recruitment/contract");
  });

  // The guard that used to live here -- "never nest one tab's href under
  // another's" -- is gone, along with the ModuleNav limitation that made it
  // necessary. ModuleNav now marks only the MOST SPECIFIC matching tab, so a
  // nested href lights up one tab rather than two. Three real pages were
  // tabless purely because of the old rule (/admin/email/templates,
  // /volunteers/ehs/manage, /schedule/attendings/credentialing) and now have
  // tabs. What replaced the guard is the nesting cases in
  // src/platform/ui/module-nav.test.tsx, which test the behaviour directly
  // instead of banning the shape that used to break it.
});
