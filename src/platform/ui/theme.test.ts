import { describe, expect, it } from "vitest";
import {
  THEME_VALUES,
  THEME_COOKIE,
  THEME_ATTR,
  isThemePreference,
  resolvePreference,
  effectiveClass,
  buildNoFlashScript,
} from "./theme";

describe("theme constants", () => {
  it("exposes the three preference values", () => {
    expect(THEME_VALUES).toEqual(["light", "dark", "system"]);
  });
});

describe("isThemePreference", () => {
  it("accepts valid values and rejects others", () => {
    expect(isThemePreference("dark")).toBe(true);
    expect(isThemePreference("system")).toBe(true);
    expect(isThemePreference("blue")).toBe(false);
    expect(isThemePreference(null)).toBe(false);
    expect(isThemePreference(undefined)).toBe(false);
  });
});

describe("resolvePreference", () => {
  it("prefers the person value", () => {
    expect(resolvePreference("dark", "light")).toBe("dark");
  });
  it("falls back to the admin default when person is null", () => {
    expect(resolvePreference(null, "dark")).toBe("dark");
  });
  it("falls back to system when both are absent", () => {
    expect(resolvePreference(null, null)).toBe("system");
  });
  it("ignores an invalid person value", () => {
    expect(resolvePreference("nope", "light")).toBe("light");
  });
});

describe("effectiveClass", () => {
  it("returns 'dark' for explicit dark regardless of OS", () => {
    expect(effectiveClass("dark", false)).toBe("dark");
  });
  it("returns '' for explicit light regardless of OS", () => {
    expect(effectiveClass("light", true)).toBe("");
  });
  it("follows the OS for system", () => {
    expect(effectiveClass("system", true)).toBe("dark");
    expect(effectiveClass("system", false)).toBe("");
  });
});

describe("buildNoFlashScript", () => {
  it("references the data attribute and toggles the dark class for system", () => {
    const js = buildNoFlashScript();
    expect(js).toContain(THEME_ATTR);
    expect(js).toContain("prefers-color-scheme: dark");
    expect(js).toContain("classList.toggle('dark'");
  });
});
