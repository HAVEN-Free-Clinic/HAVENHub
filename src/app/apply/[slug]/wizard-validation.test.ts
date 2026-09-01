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

  it("never reports a display-only NOTICE, even one marked required", () => {
    // It renders no control, so highlighting it would park the applicant on a
    // paragraph of policy text with nothing to fill in.
    expect(missingRequiredKeys([{ key: "ai_use", required: true, type: "NOTICE", validation: null }], {})).toEqual([]);
  });

  it("does report an unticked acknowledging NOTICE", () => {
    const ack = [{ key: "ai_use", required: true, type: "NOTICE", validation: { acknowledge: true } }];
    expect(missingRequiredKeys(ack, {})).toEqual(["ai_use"]);
    expect(missingRequiredKeys(ack, { ai_use: "on" })).toEqual([]);
  });
});
