import { describe, expect, it } from "vitest";
import {
  departmentChoicesFromAnswer, departmentRankCount, formatRankedDepartments, rankOrdinal,
} from "./department-choice";
import { buildApplicationSchema, type SectionDef } from "./schema-builder";
import { formatAnswer } from "./answer-display";

describe("departmentRankCount", () => {
  it("defaults to 1 so single-choice fields behave as before", () => {
    expect(departmentRankCount(null)).toBe(1);
    expect(departmentRankCount({})).toBe(1);
    expect(departmentRankCount({ rankCount: "2" })).toBe(1);
  });
  it("clamps to 1..3", () => {
    expect(departmentRankCount({ rankCount: 2 })).toBe(2);
    expect(departmentRankCount({ rankCount: 9 })).toBe(3);
    expect(departmentRankCount({ rankCount: 0 })).toBe(1);
  });
});

describe("departmentChoicesFromAnswer", () => {
  it("reads the scalar shape", () => {
    expect(departmentChoicesFromAnswer("SRHD")).toEqual(["SRHD"]);
    expect(departmentChoicesFromAnswer("")).toEqual([]);
    expect(departmentChoicesFromAnswer(undefined)).toEqual([]);
  });
  it("reads the ranked shape in order, dropping empty slots and repeats", () => {
    expect(departmentChoicesFromAnswer(["SCTP", "", "SRHD"])).toEqual(["SCTP", "SRHD"]);
    expect(departmentChoicesFromAnswer(["SRHD", "SRHD"])).toEqual(["SRHD"]);
    expect(departmentChoicesFromAnswer(["", ""])).toEqual([]);
  });
});

it("formats ranked choices with their rank and a single choice bare", () => {
  expect(formatRankedDepartments(["A"], (c) => c.toLowerCase())).toBe("a");
  expect(formatRankedDepartments(["A", "B"], (c) => c)).toBe("A (1st), B (2nd)");
  expect(rankOrdinal(1)).toBe("2nd choice");
});

describe("buildApplicationSchema for DEPARTMENT_CHOICE", () => {
  const sections = (required: boolean, validation: SectionDef["fields"][number]["validation"]): SectionDef[] => [
    {
      id: "s", appliesTo: "BOTH", departmentCode: null,
      fields: [{
        key: "dept", type: "DEPARTMENT_CHOICE", required, validation,
        options: [{ value: "SRHD", label: "SRHD" }, { value: "SCTP", label: "SCTP" }, { value: "MDIC", label: "MDIC" }],
      }],
    },
  ];
  const ctx = { applicantType: "NEW" as const, selectedDepartmentCodes: [] };

  it("keeps the scalar answer when rankCount is unset (volunteer cycles untouched)", () => {
    const schema = buildApplicationSchema(sections(true, null), ctx);
    expect(schema.parse({ dept: "SRHD" })).toEqual({ dept: "SRHD" });
    expect(schema.safeParse({ dept: ["SRHD", "SCTP"] }).success).toBe(false);
  });

  it("accepts an ordered list for a ranked field and drops empty later slots", () => {
    const schema = buildApplicationSchema(sections(true, { rankCount: 2 }), ctx);
    expect(schema.parse({ dept: ["SCTP", "SRHD"] })).toEqual({ dept: ["SCTP", "SRHD"] });
    expect(schema.parse({ dept: ["SCTP", ""] })).toEqual({ dept: ["SCTP"] });
  });

  it("requires the 1st choice only when the field is required", () => {
    expect(buildApplicationSchema(sections(true, { rankCount: 2 }), ctx).safeParse({ dept: ["", ""] }).success).toBe(false);
    expect(buildApplicationSchema(sections(false, { rankCount: 2 }), ctx).parse({ dept: ["", ""] })).toEqual({});
  });

  it("rejects a repeated department, an unknown one, and too many choices", () => {
    const schema = buildApplicationSchema(sections(true, { rankCount: 2 }), ctx);
    expect(schema.safeParse({ dept: ["SRHD", "SRHD"] }).success).toBe(false);
    expect(schema.safeParse({ dept: ["SRHD", "NOPE"] }).success).toBe(false);
    expect(schema.safeParse({ dept: ["SRHD", "SCTP", "MDIC"] }).success).toBe(false);
  });
});

it("displays a stored ranked answer in rank order and a scalar one as before", () => {
  const field = { key: "dept", type: "DEPARTMENT_CHOICE" as const };
  expect(formatAnswer(field, "SRHD")).toBe("SRHD");
  expect(formatAnswer(field, ["SCTP", "SRHD"])).toBe("SCTP (1st), SRHD (2nd)");
});
