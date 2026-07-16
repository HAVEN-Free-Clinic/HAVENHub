import { describe, it, expect } from "vitest";
import { moduleTitleForPath, seedForPathname } from "./help-context";

const LABELS = { recruitment: "Recruitment", schedule: "Clinic Schedule" };

describe("moduleTitleForPath", () => {
  it("maps the first path segment to a module title", () => {
    expect(moduleTitleForPath("/recruitment/cycles/123", LABELS)).toBe("Recruitment");
  });
  it("returns null for the root or an unknown segment", () => {
    expect(moduleTitleForPath("/", LABELS)).toBeNull();
    expect(moduleTitleForPath("/nope/here", LABELS)).toBeNull();
  });
});

describe("seedForPathname", () => {
  it("seeds a module-specific greeting and suggestions when the module is known", () => {
    const seed = seedForPathname("/recruitment", LABELS);
    expect(seed.moduleTitle).toBe("Recruitment");
    expect(seed.greeting.title).toContain("Recruitment");
    expect(seed.suggestions.some((s) => s.includes("Recruitment"))).toBe(true);
  });
  it("falls back to a generic greeting off any known module", () => {
    const seed = seedForPathname("/", LABELS);
    expect(seed.moduleTitle).toBeNull();
    expect(seed.greeting.title).toBe("How can we help?");
    expect(seed.suggestions.length).toBeGreaterThan(0);
  });
});
