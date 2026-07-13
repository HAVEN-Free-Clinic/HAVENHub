import { describe, it, expect } from "vitest";
import { ADAPTIVE_PERMISSION_CATALOG } from "./catalog";
import { buildAdaptiveClaims } from "./adaptive-claims";

describe("buildAdaptiveClaims", () => {
  it("wildcard '*' grants every leaf", () => {
    const { can } = buildAdaptiveClaims(new Set(["*"]));
    for (const mod of Object.values(can)) {
      for (const granted of Object.values(mod)) expect(granted).toBe(true);
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

  it("emits exactly one boolean leaf per catalog permission", () => {
    const { can } = buildAdaptiveClaims(new Set());
    const leaves: string[] = [];
    for (const mod of Object.keys(can)) {
      for (const action of Object.keys(can[mod])) leaves.push(`${mod}.${action}`);
    }
    expect(leaves.sort()).toEqual([...ADAPTIVE_PERMISSION_CATALOG].sort());
  });
});
