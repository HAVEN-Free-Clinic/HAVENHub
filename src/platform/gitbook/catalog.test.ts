import { describe, it, expect } from "vitest";
import { MODULES } from "@/platform/modules/registry";
import { ADAPTIVE_PERMISSION_CATALOG, buildNested, buildAdaptiveSchema } from "./catalog";

describe("ADAPTIVE_PERMISSION_CATALOG", () => {
  it("is the sorted, de-duped union of every module's permissions", () => {
    const expected = [...new Set(MODULES.flatMap((m) => m.permissions))].sort();
    expect(ADAPTIVE_PERMISSION_CATALOG).toEqual(expected);
  });

  it("every entry is a single-dot namespace.action string", () => {
    for (const p of ADAPTIVE_PERMISSION_CATALOG) {
      expect(p.split(".").length).toBe(2);
    }
  });
});

describe("buildNested", () => {
  it("groups each permission under module -> action", () => {
    const nested = buildNested(() => true);
    // schedule.view and schedule.edit_all both live under `schedule`
    expect(nested.schedule.view).toBe(true);
    expect(nested.schedule.edit_all).toBe(true);
    expect(nested.learning.manage_courses).toBe(true);
  });

  it("covers exactly the catalog (no missing or extra leaves)", () => {
    const leaves: string[] = [];
    const nested = buildNested((p) => p);
    for (const mod of Object.keys(nested)) {
      for (const action of Object.keys(nested[mod])) leaves.push(`${mod}.${action}`);
    }
    expect(leaves.sort()).toEqual([...ADAPTIVE_PERMISSION_CATALOG].sort());
  });
});

describe("buildAdaptiveSchema", () => {
  it("emits a top-level object with a `can` property of nested boolean leaves", () => {
    const schema = buildAdaptiveSchema();
    expect(schema.type).toBe("object");
    const can = schema.properties.can as {
      type: string;
      properties: Record<string, { properties: Record<string, { type: string }> }>;
    };
    expect(can.type).toBe("object");
    expect(can.properties.schedule.properties.view.type).toBe("boolean");
    expect(can.properties.admin.properties.access.type).toBe("boolean");
  });

  it("does not forbid additional top-level claims (name/email/iat/exp survive)", () => {
    const schema = buildAdaptiveSchema() as { additionalProperties?: boolean };
    // omitted or true — never false, or GitBook would reject standard JWT claims
    expect(schema.additionalProperties).not.toBe(false);
  });
});
