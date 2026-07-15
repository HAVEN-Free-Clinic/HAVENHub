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

describe("MULTI_SELECT normalization", () => {
  const build = (required: boolean, max?: number) => {
    const secs: SectionDef[] = [
      {
        id: "s", appliesTo: "BOTH", departmentCode: null,
        fields: [{
          key: "shifts", type: "MULTI_SELECT", required,
          options: [{ value: "am", label: "AM" }, { value: "pm", label: "PM" }],
          validation: max !== undefined ? { max } : null,
        }],
      },
    ];
    return buildApplicationSchema(secs, { applicantType: "NEW", selectedDepartmentCodes: [] });
  };

  it("accepts a single checked box serialized as a scalar string", () => {
    const r = build(true).safeParse({ shifts: "am" });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.shifts).toEqual(["am"]);
  });

  it("accepts multiple checked boxes (array)", () => {
    expect(build(true).safeParse({ shifts: ["am", "pm"] }).success).toBe(true);
  });

  it("rejects a required multi-select with nothing checked", () => {
    expect(build(true).safeParse({}).success).toBe(false);
  });

  it("treats an absent optional multi-select as undefined", () => {
    const r = build(false).safeParse({});
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.shifts).toBeUndefined();
  });

  it("still enforces the option enum and max", () => {
    expect(build(true).safeParse({ shifts: "bogus" }).success).toBe(false);
    expect(build(true, 1).safeParse({ shifts: ["am", "pm"] }).success).toBe(false);
  });
});

describe("NUMBER blank handling", () => {
  const build = (required: boolean) => {
    const secs: SectionDef[] = [
      {
        id: "s", appliesTo: "BOTH", departmentCode: null,
        fields: [{ key: "years", type: "NUMBER", required, options: null, validation: null }],
      },
    ];
    return buildApplicationSchema(secs, { applicantType: "NEW", selectedDepartmentCodes: [] });
  };

  it("does not coerce a blank optional number to 0", () => {
    const r = build(false).safeParse({ years: "" });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.years).toBeUndefined();
  });

  it("rejects a blank required number instead of accepting 0", () => {
    expect(build(true).safeParse({ years: "" }).success).toBe(false);
  });

  it("still parses a provided numeric string", () => {
    const r = build(false).safeParse({ years: "3" });
    expect(r.success && r.data.years).toBe(3);
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

it("excludes SUBCOMMITTEE_RANK from the generated scalar schema (handled in submissions)", () => {
  const sections = [{
    id: "s1", appliesTo: "BOTH" as const, departmentCode: null,
    fields: [
      { key: "subs", type: "SUBCOMMITTEE_RANK" as const, required: true, options: null, validation: { rankCount: 3 } },
      { key: "name", type: "SHORT_TEXT" as const, required: true, options: null, validation: null },
    ],
  }];
  const schema = buildApplicationSchema(sections, { applicantType: "NEW", selectedDepartmentCodes: [] });
  const parsed = schema.parse({ name: "Ann" }); // no `subs` key needed
  expect(parsed).toEqual({ name: "Ann" });
});

describe("SIGNATURE validation", () => {
  const sig = (required: boolean): SectionDef[] => [
    { id: "s", appliesTo: "BOTH", departmentCode: null,
      fields: [{ key: "sign", type: "SIGNATURE", required, options: null, validation: null }] },
  ];
  const PNG = "data:image/png;base64,iVBORw0KGgo=";

  it("accepts a png data URL for a required signature", () => {
    expect(buildApplicationSchema(sig(true), ctx).safeParse({ sign: PNG }).success).toBe(true);
  });
  it("rejects an empty required signature", () => {
    expect(buildApplicationSchema(sig(true), ctx).safeParse({ sign: "" }).success).toBe(false);
  });
  it("rejects a non-png value for a required signature", () => {
    expect(buildApplicationSchema(sig(true), ctx).safeParse({ sign: "typed name" }).success).toBe(false);
  });
  it("allows an empty optional signature", () => {
    expect(buildApplicationSchema(sig(false), ctx).safeParse({ sign: "" }).success).toBe(true);
  });
});

describe("visibleWhen (condition-hidden fields)", () => {
  const conditionalSections: SectionDef[] = [
    {
      id: "s", appliesTo: "BOTH", departmentCode: null,
      fields: [
        { key: "g", type: "SHORT_TEXT", required: false, options: null, validation: null },
        {
          key: "detail", type: "SHORT_TEXT", required: true, options: null, validation: null,
          visibleWhen: { field: "g", op: "is", value: "yes" },
        },
      ],
    },
  ];

  it("excludes a condition-hidden required field from the schema, so parsing without it succeeds", () => {
    const schema = buildApplicationSchema(conditionalSections, {
      applicantType: "NEW", selectedDepartmentCodes: [], answers: { g: "no" },
    });
    expect(schema.safeParse({ g: "no" }).success).toBe(true);
  });

  it("requires the field once its condition is met", () => {
    const schema = buildApplicationSchema(conditionalSections, {
      applicantType: "NEW", selectedDepartmentCodes: [], answers: { g: "yes" },
    });
    expect(schema.safeParse({ g: "yes" }).success).toBe(false);
    expect(schema.safeParse({ g: "yes", detail: "because" }).success).toBe(true);
  });

  it("excludes a condition-hidden required FILE field from requiredFileKeys, and includes it once visible", () => {
    const withConditionalFile: SectionDef[] = [
      {
        id: "s", appliesTo: "BOTH", departmentCode: null,
        fields: [
          { key: "g", type: "SHORT_TEXT", required: false, options: null, validation: null },
          {
            key: "proof", type: "FILE", required: true, options: null, validation: null,
            visibleWhen: { field: "g", op: "is", value: "yes" },
          },
        ],
      },
    ];
    expect(requiredFileKeys(withConditionalFile, { applicantType: "NEW", selectedDepartmentCodes: [], answers: { g: "no" } })).toEqual([]);
    expect(requiredFileKeys(withConditionalFile, { applicantType: "NEW", selectedDepartmentCodes: [], answers: { g: "yes" } })).toEqual(["proof"]);
  });
});
