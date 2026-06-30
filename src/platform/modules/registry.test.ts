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
        "learning",
        "my-info",
        "patient-trackers",
        "recruitment",
        "referrals",
        "schedule",
        "triage",
        "volunteers",
      ].sort()
    );
  });
});
