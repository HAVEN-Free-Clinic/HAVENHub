import { describe, expect, it } from "vitest";
import { MODULES } from "./registry";

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
        "recruitment",
        "schedule",
        "support",
        "volunteers",
      ].sort()
    );
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
    // manageableRequestDepartmentIds, canManageAnyRhdDept) that no permission
    // string can express. Without dynamicGate the global nav's Schedule dropdown
    // offers all three to any schedule.view holder -- and every seeded volunteer
    // role holds schedule.view -- so the links bounce to /no-access. Losing the
    // marker silently reintroduces those dead ends, hence this assertion.
    const schedule = MODULES.find((m) => m.id === "schedule")!;
    const gated = schedule.nav.filter((n) => n.dynamicGate).map((n) => n.href);
    expect(gated.sort()).toEqual(
      ["/schedule/builder", "/schedule/requests", "/schedule/attendings"].sort(),
    );
  });

  it("uses dynamicGate nowhere else, so the global nav stays as complete as it safely can", () => {
    const gated = MODULES.flatMap((m) =>
      m.nav.filter((n) => n.dynamicGate).map((n) => `${m.id}:${n.href}`),
    );
    expect(gated.every((h) => h.startsWith("schedule:"))).toBe(true);
  });

  it("gives the onboarding contract editor a nav entry so it is not orphaned", () => {
    const admin = MODULES.find((m) => m.id === "admin")!;
    expect(admin.nav.map((n) => n.href)).toContain("/admin/contract");
  });
});
