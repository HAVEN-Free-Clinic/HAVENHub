import { describe, it, expect } from "vitest";
import { MODULES } from "@/platform/modules/registry";
import {
  ADAPTIVE_DERIVED_CLAIMS,
  ADAPTIVE_PERMISSION_CATALOG,
  buildNested,
  buildAdaptiveSchema,
} from "./catalog";

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
    // buildNested stays pure: only registry permissions, no data-driven claims.
    expect(leaves.sort()).toEqual([...ADAPTIVE_PERMISSION_CATALOG].sort());
  });
});

describe("ADAPTIVE_DERIVED_CLAIMS", () => {
  it("are data-driven leaves that are NOT registry permissions", () => {
    for (const claim of ADAPTIVE_DERIVED_CLAIMS) {
      expect(ADAPTIVE_PERMISSION_CATALOG).not.toContain(`${claim.module}.${claim.action}`);
      expect(claim.description.length).toBeGreaterThan(0);
    }
  });

  it("cover the schedule Builder and Attendings capability gates", () => {
    const keys = ADAPTIVE_DERIVED_CLAIMS.map((c) => `${c.module}.${c.action}`);
    expect(keys).toContain("schedule.manages_any_dept");
    expect(keys).toContain("schedule.manages_any_rhd_dept");
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
    // Data-driven claims are published alongside the permission leaves.
    expect(can.properties.schedule.properties.manages_any_dept.type).toBe("boolean");
    expect(can.properties.schedule.properties.manages_any_rhd_dept.type).toBe("boolean");
  });

  it("satisfies GitBook's SiteAdaptiveJSONSchema contract: every object node has a description and additionalProperties:false", () => {
    // GitBook requires additionalProperties:false at every object level (standard
    // name/email/iat/exp claims are reserved and validated outside this schema),
    // and requires a description on every object node.
    type ObjNode = {
      type: string;
      description?: string;
      properties: Record<string, ObjNode>;
      additionalProperties?: boolean;
    };
    const schema = buildAdaptiveSchema() as unknown as ObjNode;
    expect(schema.type).toBe("object");
    expect(schema.additionalProperties).toBe(false);

    const can = schema.properties.can;
    expect(can.type).toBe("object");
    expect(typeof can.description).toBe("string");
    expect(can.description!.length).toBeGreaterThan(0);
    expect(can.additionalProperties).toBe(false);

    for (const [mod, moduleNode] of Object.entries(can.properties)) {
      expect(moduleNode.type, mod).toBe("object");
      expect(typeof moduleNode.description, mod).toBe("string");
      expect(moduleNode.description!.length, mod).toBeGreaterThan(0);
      expect(moduleNode.additionalProperties, mod).toBe(false);
      for (const [action, leaf] of Object.entries(moduleNode.properties)) {
        expect(leaf.type, `${mod}.${action}`).toBe("boolean");
        expect(typeof leaf.description, `${mod}.${action}`).toBe("string");
      }
    }
  });
});
