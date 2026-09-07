import { describe, expect, it } from "vitest";
import {
  DUAL_ROLE_DEPARTMENT_CODES,
  DUAL_ROLE_FIELDS,
  dualRoleDepartmentsFromAnswers,
  dualRolesToRecord,
  isChecked,
  isDualRoleDepartment,
} from "./catalog";

describe("isChecked", () => {
  // Both spellings reach the stored answers depending on which path wrote the
  // row, so treating only one as checked would silently drop half the interest.
  it("accepts the boolean and the browser's 'on'", () => {
    expect(isChecked(true)).toBe(true);
    expect(isChecked("on")).toBe(true);
  });

  it("treats every other value as unchecked", () => {
    for (const v of [false, "", null, undefined, "off", 0, 1, "true", {}, []]) {
      expect(isChecked(v)).toBe(false);
    }
  });
});

describe("dualRoleDepartmentsFromAnswers", () => {
  it("maps each checked field to its department code", () => {
    expect(dualRoleDepartmentsFromAnswers({ vadm_dual_option: true })).toEqual(["VADM"]);
    expect(dualRoleDepartmentsFromAnswers({ intp_dual_option: "on" })).toEqual(["INTP"]);
  });

  it("returns both codes sorted when both are checked", () => {
    expect(
      dualRoleDepartmentsFromAnswers({ intp_dual_option: true, vadm_dual_option: "on" }),
    ).toEqual(["INTP", "VADM"]);
  });

  it("ignores unchecked, unrelated, and missing fields", () => {
    expect(
      dualRoleDepartmentsFromAnswers({
        vadm_dual_option: false,
        intp_dual_option: "",
        some_other_field: true,
      }),
    ).toEqual([]);
    expect(dualRoleDepartmentsFromAnswers({})).toEqual([]);
  });

  it("survives a non-object answers blob rather than throwing", () => {
    // Application.answers is Json: a malformed row must not take promotion down.
    for (const v of [null, undefined, "string", 42]) {
      expect(dualRoleDepartmentsFromAnswers(v)).toEqual([]);
    }
  });
});

describe("dualRolesToRecord", () => {
  it("keeps a declared dual department the applicant does not already hold", () => {
    expect(
      dualRolesToRecord({
        declared: ["VADM"],
        primaryDepartmentCode: "MDIC",
        activeDepartmentCodes: [],
      }),
    ).toEqual(["VADM"]);
  });

  it("drops the dual department when it IS the primary one", () => {
    // Ticking "I'll also do vaccines" on an application routed to VADM must not
    // ask VADM's director to add somebody already on their roster.
    expect(
      dualRolesToRecord({
        declared: ["VADM", "INTP"],
        primaryDepartmentCode: "VADM",
        activeDepartmentCodes: [],
      }),
    ).toEqual(["INTP"]);
  });

  it("drops a department the person is already an active member of", () => {
    expect(
      dualRolesToRecord({
        declared: ["VADM"],
        primaryDepartmentCode: "MDIC",
        activeDepartmentCodes: ["VADM"],
      }),
    ).toEqual([]);
  });

  it("drops a code that is not a dual-role department at all", () => {
    // Guards the column against a stale or hand-written value: only departments
    // that actually offer a dual role can produce a queue row.
    expect(
      dualRolesToRecord({
        declared: ["MDIC", "VADM"],
        primaryDepartmentCode: "PATS",
        activeDepartmentCodes: [],
      }),
    ).toEqual(["VADM"]);
  });

  it("de-duplicates and sorts", () => {
    expect(
      dualRolesToRecord({
        declared: ["VADM", "VADM", "INTP"],
        primaryDepartmentCode: "PATS",
        activeDepartmentCodes: [],
      }),
    ).toEqual(["INTP", "VADM"]);
  });
});

describe("the catalog itself", () => {
  it("derives the department code list from the field map", () => {
    expect(DUAL_ROLE_DEPARTMENT_CODES).toEqual(["INTP", "VADM"]);
    expect(isDualRoleDepartment("VADM")).toBe(true);
    expect(isDualRoleDepartment("MDIC")).toBe(false);
  });

  it("keys the map on the field keys the application template writes", () => {
    // If additionalOpportunitiesSection is renamed or its keys change, this
    // fails here rather than by silently recording nothing at submit.
    expect(Object.keys(DUAL_ROLE_FIELDS).sort()).toEqual([
      "intp_dual_option",
      "vadm_dual_option",
    ]);
  });
});
