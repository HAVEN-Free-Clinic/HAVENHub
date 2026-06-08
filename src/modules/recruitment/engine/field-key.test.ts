import { describe, expect, it } from "vitest";
import { slugifyKey, uniqueKey } from "./field-key";

describe("slugifyKey", () => {
  it("lowercases and underscores non-alphanumerics", () => {
    expect(slugifyKey("1st-Choice Department/Position")).toBe("1st_choice_department_position");
  });
  it("trims leading/trailing separators", () => {
    expect(slugifyKey("  Résumé?  ")).toBe("r_sum");
  });
  it("falls back to 'field' for empty input", () => {
    expect(slugifyKey("!!!")).toBe("field");
  });
});

describe("uniqueKey", () => {
  it("returns the base key when unused", () => {
    expect(uniqueKey("Email", [])).toBe("email");
  });
  it("suffixes _2, _3 on collision", () => {
    expect(uniqueKey("Email", ["email"])).toBe("email_2");
    expect(uniqueKey("Email", ["email", "email_2"])).toBe("email_3");
  });
});
