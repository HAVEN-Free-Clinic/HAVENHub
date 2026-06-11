import { describe, it, expect } from "vitest";
import { isAllowlistedPath } from "./onboarding-allowlist";

describe("isAllowlistedPath", () => {
  it("matches each allowlisted root exactly", () => {
    for (const p of ["/get-started", "/my-info", "/training", "/learning", "/login", "/welcome"]) {
      expect(isAllowlistedPath(p)).toBe(true);
    }
  });

  it("matches sub-paths of an allowlisted root", () => {
    expect(isAllowlistedPath("/learning/abc")).toBe(true);
    expect(isAllowlistedPath("/learning/play/123/index.html")).toBe(true);
    expect(isAllowlistedPath("/my-info/anything")).toBe(true);
  });

  it("does not match gated pages", () => {
    expect(isAllowlistedPath("/")).toBe(false);
    expect(isAllowlistedPath("/schedule")).toBe(false);
    expect(isAllowlistedPath("/volunteers")).toBe(false);
    expect(isAllowlistedPath("/admin")).toBe(false);
  });

  it("does not treat a longer sibling as a prefix match", () => {
    // "/my-information" must NOT be allowlisted just because it starts with "/my-info".
    expect(isAllowlistedPath("/my-information")).toBe(false);
    expect(isAllowlistedPath("/trainings")).toBe(false);
  });
});
