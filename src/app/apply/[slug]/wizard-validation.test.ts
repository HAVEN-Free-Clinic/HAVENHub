import { describe, expect, it } from "vitest";
import { isValuePresent, missingRequiredKeys } from "./wizard-validation";

describe("isValuePresent", () => {
  it("treats non-empty strings as present and blank/whitespace as absent", () => {
    expect(isValuePresent("Ann")).toBe(true);
    expect(isValuePresent("")).toBe(false);
    expect(isValuePresent("   ")).toBe(false);
  });
  it("treats an array with any non-empty entry as present", () => {
    expect(isValuePresent(["", "b"])).toBe(true);
    expect(isValuePresent(["", ""])).toBe(false);
    expect(isValuePresent([])).toBe(false);
  });
  it("treats undefined as absent and a checked checkbox ('on') as present", () => {
    expect(isValuePresent(undefined)).toBe(false);
    expect(isValuePresent("on")).toBe(true);
  });
});

describe("missingRequiredKeys", () => {
  const fields = [
    { key: "first_name", required: true, type: "TEXT" },
    { key: "middle", required: false, type: "TEXT" },
    { key: "resume", required: true, type: "FILE" },
  ];
  it("returns only required keys whose value is absent", () => {
    expect(missingRequiredKeys(fields, { first_name: "Ann" })).toEqual(["resume"]);
  });
  it("counts an attached file (truthy string) as present", () => {
    expect(missingRequiredKeys(fields, { first_name: "Ann", resume: "attached" })).toEqual([]);
  });
  it("returns [] when there are no required fields", () => {
    expect(missingRequiredKeys([{ key: "x", required: false, type: "TEXT" }], {})).toEqual([]);
  });
});
