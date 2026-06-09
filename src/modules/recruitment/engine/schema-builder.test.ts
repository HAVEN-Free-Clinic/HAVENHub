import { describe, expect, it } from "vitest";
import { buildApplicationSchema, requiredFileKeys, type SectionDef } from "./schema-builder";

const ctx = { applicantType: "NEW" as const, selectedDepartmentCodes: ["SRHD"] };

const sections: SectionDef[] = [
  {
    id: "identity",
    appliesTo: "BOTH",
    departmentCode: null,
    fields: [
      { key: "email", type: "EMAIL", required: true, options: null, validation: null },
      { key: "phone", type: "PHONE", required: false, options: null, validation: null },
      { key: "essay", type: "LONG_TEXT", required: true, options: null, validation: { min: 10 } },
      { key: "year", type: "NUMBER", required: true, options: null, validation: { min: 2025, max: 2031 } },
      { key: "agree", type: "CHECKBOX", required: true, options: null, validation: null },
      { key: "dept", type: "SINGLE_SELECT", required: true, options: [{ value: "a", label: "A" }], validation: null },
    ],
  },
  {
    id: "srhd",
    appliesTo: "NEW",
    departmentCode: "SRHD",
    fields: [{ key: "srhd_q1", type: "LONG_TEXT", required: true, options: null, validation: null }],
  },
  {
    id: "mdic",
    appliesTo: "NEW",
    departmentCode: "MDIC",
    fields: [{ key: "mdic_q1", type: "LONG_TEXT", required: true, options: null, validation: null }],
  },
];

describe("buildApplicationSchema", () => {
  it("accepts a valid payload for chosen departments", () => {
    const schema = buildApplicationSchema(sections, ctx);
    const result = schema.safeParse({
      email: "a@yale.edu", phone: "", essay: "a sufficiently long answer", year: 2026, agree: true, dept: "a", srhd_q1: "my srhd answer",
    });
    expect(result.success).toBe(true);
  });

  it("does not require fields from unchosen-department supplements", () => {
    const schema = buildApplicationSchema(sections, ctx);
    const result = schema.safeParse({
      email: "a@yale.edu", essay: "a sufficiently long answer", year: 2026, agree: true, dept: "a", srhd_q1: "my srhd answer",
    });
    expect(result.success).toBe(true);
  });

  it("rejects a missing required field", () => {
    const schema = buildApplicationSchema(sections, ctx);
    const result = schema.safeParse({ email: "a@yale.edu", year: 2026, agree: true, dept: "a", srhd_q1: "x" });
    expect(result.success).toBe(false);
  });

  it("rejects an unchecked required checkbox", () => {
    const schema = buildApplicationSchema(sections, ctx);
    const result = schema.safeParse({ email: "a@yale.edu", essay: "long enough answer", year: 2026, agree: false, dept: "a", srhd_q1: "x" });
    expect(result.success).toBe(false);
  });

  it("rejects an out-of-range number", () => {
    const schema = buildApplicationSchema(sections, ctx);
    const result = schema.safeParse({ email: "a@yale.edu", essay: "long enough answer", year: 1999, agree: true, dept: "a", srhd_q1: "x" });
    expect(result.success).toBe(false);
  });

  it("rejects a select value outside its options", () => {
    const schema = buildApplicationSchema(sections, ctx);
    const result = schema.safeParse({ email: "a@yale.edu", essay: "long enough answer", year: 2026, agree: true, dept: "nope", srhd_q1: "x" });
    expect(result.success).toBe(false);
  });
});

describe("requiredFileKeys", () => {
  it("returns required FILE keys only in visible sections", () => {
    const withFiles: SectionDef[] = [
      { id: "a", appliesTo: "BOTH", departmentCode: null, fields: [{ key: "resume", type: "FILE", required: true, options: null, validation: null }] },
      { id: "b", appliesTo: "BOTH", departmentCode: "MDIC", fields: [{ key: "portfolio", type: "FILE", required: true, options: null, validation: null }] },
    ];
    expect(requiredFileKeys(withFiles, ctx)).toEqual(["resume"]); // MDIC not chosen
  });
});
