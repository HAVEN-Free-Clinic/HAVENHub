import { describe, it, expect } from "vitest";
import { getApplicationTemplate } from "./index";

const dates = [{ label: "May 30", value: "2026-05-30" }];

describe("getApplicationTemplate", () => {
  it("includes the three identity keys for both tracks", () => {
    for (const track of ["VOLUNTEER", "DIRECTOR"] as const) {
      const keys = getApplicationTemplate(track, [], dates).flatMap((s) => s.fields.map((f) => f.key));
      expect(keys).toEqual(expect.arrayContaining(["first_name", "last_name", "email"]));
    }
  });

  it("emits exactly one DEPARTMENT_CHOICE field", () => {
    const fields = getApplicationTemplate("VOLUNTEER", ["MDIC"], dates).flatMap((s) => s.fields);
    expect(fields.filter((f) => f.type === "DEPARTMENT_CHOICE")).toHaveLength(1);
  });

  it("materializes a supplement section only for selected departments", () => {
    const t = getApplicationTemplate("VOLUNTEER", ["MDIC"], dates);
    const suppCodes = t.filter((s) => s.departmentCode !== null).map((s) => s.departmentCode);
    expect(suppCodes).toEqual(["MDIC"]);
  });

  it("has globally unique field keys and monotonic section order", () => {
    const t = getApplicationTemplate("DIRECTOR", ["BVHD", "MDIC"], dates);
    const keys = t.flatMap((s) => s.fields.map((f) => f.key));
    expect(new Set(keys).size).toBe(keys.length);
    expect(t.map((s) => s.order)).toEqual(t.map((_, i) => i));
  });

  it("ships no generic placeholder labels", () => {
    const labels = getApplicationTemplate("DIRECTOR", ["BVHD"], dates).flatMap((s) => s.fields.map((f) => f.label));
    for (const l of labels) expect(l).not.toMatch(/supplement #?\d+$/i);
  });
});
