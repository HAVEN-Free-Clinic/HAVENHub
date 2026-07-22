import { describe, expect, it } from "vitest";
import { epicRequirement, optionalInt } from "./form-coerce";

describe("optionalInt", () => {
  it("maps empty/absent to null and parses a number otherwise", () => {
    expect(optionalInt(null)).toBeNull();
    expect(optionalInt("")).toBeNull();
    expect(optionalInt("   ")).toBeNull();
    expect(optionalInt("5")).toBe(5);
  });
});

describe("epicRequirement", () => {
  it("passes through the three valid enum values", () => {
    expect(epicRequirement("ALL")).toBe("ALL");
    expect(epicRequirement("SOME")).toBe("SOME");
    expect(epicRequirement("NONE")).toBe("NONE");
  });

  it("falls back to NONE for absent or unrecognized input, so a crafted post never over-provisions Epic", () => {
    expect(epicRequirement(null)).toBe("NONE");
    expect(epicRequirement("")).toBe("NONE");
    expect(epicRequirement("all")).toBe("NONE"); // case-sensitive: the Select submits uppercase
    expect(epicRequirement("EVERYONE")).toBe("NONE");
  });
});
