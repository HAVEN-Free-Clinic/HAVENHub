import { describe, it, expect } from "vitest";
import { ADAPTIVE_DERIVED_CLAIMS, ADAPTIVE_PERMISSION_CATALOG } from "./catalog";
import { buildAdaptiveClaims } from "./adaptive-claims";

describe("buildAdaptiveClaims", () => {
  it("wildcard '*' grants every permission leaf", () => {
    // Only permission leaves are governed by the permission set; data-driven
    // claims are computed elsewhere and default to false here.
    const { can } = buildAdaptiveClaims(new Set(["*"]));
    for (const p of ADAPTIVE_PERMISSION_CATALOG) {
      const [mod, action] = p.split(".");
      expect(can[mod][action], p).toBe(true);
    }
  });

  it("grants only the held permission and nothing else", () => {
    const { can } = buildAdaptiveClaims(new Set(["schedule.view"]));
    expect(can.schedule.view).toBe(true);
    expect(can.schedule.edit_all).toBe(false);
    expect(can.admin.access).toBe(false);
    expect(can.learning.manage_courses).toBe(false);
  });

  it("empty permission set grants nothing", () => {
    const { can } = buildAdaptiveClaims(new Set());
    for (const mod of Object.values(can)) {
      for (const granted of Object.values(mod)) expect(granted).toBe(false);
    }
  });

  it("emits one boolean leaf per catalog permission plus each derived claim", () => {
    const { can } = buildAdaptiveClaims(new Set());
    const leaves: string[] = [];
    for (const mod of Object.keys(can)) {
      for (const action of Object.keys(can[mod])) leaves.push(`${mod}.${action}`);
    }
    const expected = [
      ...ADAPTIVE_PERMISSION_CATALOG,
      ...ADAPTIVE_DERIVED_CLAIMS.map((c) => `${c.module}.${c.action}`),
    ].sort();
    expect(leaves.sort()).toEqual(expected);
  });

  it("sets derived claims from the provided map, defaulting omitted ones to false", () => {
    const { can } = buildAdaptiveClaims(new Set(), { "schedule.manages_any_dept": true });
    expect(can.schedule.manages_any_dept).toBe(true);
    expect(can.schedule.manages_any_rhd_dept).toBe(false);
    // A derived value is independent of the permission set.
    expect(can.schedule.view).toBe(false);
  });

  it("does not let a derived claim value leak onto a permission leaf", () => {
    // Passing a bogus key must not flip any real leaf.
    const { can } = buildAdaptiveClaims(new Set(["schedule.view"]), {
      "schedule.view": false as unknown as boolean,
    });
    // schedule.view is a permission leaf, so it follows the permission set, not `derived`.
    expect(can.schedule.view).toBe(true);
  });
});
