import { describe, it, expect } from "vitest";
import { newCondition, changeOp, changeValue } from "./condition-ops";
import type { FieldCondition } from "@/modules/recruitment/engine/field-visibility";

const fields = [{ value: "department", label: "Department" }, { value: "track", label: "Track" }];

describe("newCondition", () => {
  it("seeds an equals condition on the first field option", () => {
    expect(newCondition(fields)).toEqual({ field: "department", op: "is", value: "" });
  });

  it("returns undefined when there is nothing to key on", () => {
    expect(newCondition([])).toBeUndefined();
  });
});

describe("changeOp", () => {
  it("drops the value when switching to isAnswered", () => {
    expect(changeOp({ field: "department", op: "is", value: "BVHD" }, "isAnswered"))
      .toEqual({ field: "department", op: "isAnswered" });
  });

  it("restores an empty value when switching away from isAnswered", () => {
    expect(changeOp({ field: "department", op: "isAnswered" }, "is"))
      .toEqual({ field: "department", op: "is", value: "" });
  });

  it("preserves the value when switching between is and isNot", () => {
    expect(changeOp({ field: "department", op: "is", value: "BVHD" }, "isNot"))
      .toEqual({ field: "department", op: "isNot", value: "BVHD" });
  });
});

describe("changeValue", () => {
  it("splits a comma-separated string into an array for isAnyOf", () => {
    expect(changeValue({ field: "department", op: "isAnyOf", value: ["BVHD"] }, "BVHD, MDIC"))
      .toEqual({ field: "department", op: "isAnyOf", value: ["BVHD", "MDIC"] });
  });

  it("trims whitespace and drops empty entries for isAnyOf", () => {
    expect(changeValue({ field: "department", op: "isAnyOf", value: [] }, " BVHD ,  , MDIC, "))
      .toEqual({ field: "department", op: "isAnyOf", value: ["BVHD", "MDIC"] });
  });

  it("sets a plain string value for is", () => {
    expect(changeValue({ field: "department", op: "is", value: "" }, "BVHD"))
      .toEqual({ field: "department", op: "is", value: "BVHD" });
  });

  it("sets a plain string value for isNot", () => {
    expect(changeValue({ field: "department", op: "isNot", value: "" }, "BVHD"))
      .toEqual({ field: "department", op: "isNot", value: "BVHD" });
  });

  it("leaves isAnswered unchanged regardless of raw input", () => {
    const cond: FieldCondition = { field: "department", op: "isAnswered" };
    expect(changeValue(cond, "anything")).toEqual(cond);
  });

  it("does not mutate the input condition", () => {
    const cond: FieldCondition = { field: "department", op: "isAnyOf", value: ["BVHD"] };
    const original = { ...cond, value: [...cond.value as string[]] };
    changeValue(cond, "MDIC");
    expect(cond).toEqual(original);
  });
});
