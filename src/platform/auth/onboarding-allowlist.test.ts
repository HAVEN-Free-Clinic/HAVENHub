import { describe, it, expect } from "vitest";
import { isAllowlistedPath } from "./onboarding-allowlist";

describe("isAllowlistedPath", () => {
  it("matches each allowlisted root exactly", () => {
    for (const p of ["/get-started", "/login", "/welcome"]) {
      expect(isAllowlistedPath(p)).toBe(true);
    }
  });

  it("matches the onboarding sub-routes via the /get-started prefix", () => {
    expect(isAllowlistedPath("/get-started/profile")).toBe(true);
    expect(isAllowlistedPath("/get-started/hipaa")).toBe(true);
    expect(isAllowlistedPath("/get-started/training")).toBe(true);
    expect(isAllowlistedPath("/get-started/learning")).toBe(true);
  });

  it("no longer allowlists the learning module: the course player moved into /get-started", () => {
    expect(isAllowlistedPath("/learning")).toBe(false);
    expect(isAllowlistedPath("/learning/abc")).toBe(false);
    expect(isAllowlistedPath("/learning/play/123/index.html")).toBe(false);
  });

  it("allowlists the onboarding course player", () => {
    expect(isAllowlistedPath("/get-started/learning")).toBe(true);
    expect(isAllowlistedPath("/get-started/learning/abc")).toBe(true);
  });

  it("no longer allowlists the live my-info and training pages", () => {
    expect(isAllowlistedPath("/my-info")).toBe(false);
    expect(isAllowlistedPath("/my-info/anything")).toBe(false);
    expect(isAllowlistedPath("/training")).toBe(false);
  });

  it("does not match gated pages", () => {
    expect(isAllowlistedPath("/")).toBe(false);
    expect(isAllowlistedPath("/schedule")).toBe(false);
    expect(isAllowlistedPath("/admin")).toBe(false);
  });

  it("does not treat a longer sibling as a prefix match", () => {
    expect(isAllowlistedPath("/learnings")).toBe(false);
    expect(isAllowlistedPath("/get-started-extra")).toBe(false);
  });
});
