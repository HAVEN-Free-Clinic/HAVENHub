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

  it("keeps module titles short enough that the nav row fits without overflow", () => {
    // GlobalNav collapses overflow into a "More" dropdown, which hides modules
    // from exactly the users who can access the most. The pill has roughly 820px
    // after the logo and right-hand controls; at text-sm plus px-2.5 padding a
    // title costs roughly 7px per character plus 20px. Budget the row at 90
    // characters total so a full admin never overflows on a laptop.
    // my-info moves to the account menu in Task 4, which replaces this id check
    // with the `!m.personal` predicate. Excluded here so the budget is measured
    // against the same set both before and after that change.
    const rowTitles = MODULES.filter((m) => m.status === "active" && m.id !== "my-info").map((m) => m.title);
    const chars = rowTitles.reduce((sum, t) => sum + t.length, 0);
    expect(chars, `nav row titles total ${chars} chars: ${rowTitles.join(", ")}`).toBeLessThanOrEqual(90);
  });

  it("gives the onboarding contract editor a nav entry so it is not orphaned", () => {
    const admin = MODULES.find((m) => m.id === "admin")!;
    expect(admin.nav.map((n) => n.href)).toContain("/admin/contract");
  });
});
