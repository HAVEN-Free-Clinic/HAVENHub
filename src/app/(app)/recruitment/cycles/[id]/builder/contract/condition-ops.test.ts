import { describe, it, expect } from "vitest";
import { newCondition, changeOp } from "./condition-ops";

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
