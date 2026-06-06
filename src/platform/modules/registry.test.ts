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

  it("includes each module's accessPermission in its declared permissions", () => {
    for (const m of MODULES) {
      expect(m.permissions).toContain(m.accessPermission);
    }
  });

  it("registers the eight modules from the spec", () => {
    expect(MODULES.map((m) => m.id).sort()).toEqual(
      [
        "admin",
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
