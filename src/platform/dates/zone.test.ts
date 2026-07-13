import { describe, it, expect } from "vitest";
import { normalizeZone, DEFAULT_TIME_ZONE, US_TIME_ZONE_IDS, US_TIME_ZONES } from "./zone";
import { SETTINGS } from "@/platform/settings/registry";

describe("normalizeZone", () => {
  it("passes through a known US zone", () => {
    expect(normalizeZone("America/Chicago")).toBe("America/Chicago");
  });
  it("falls back to the default for unknown/empty/null", () => {
    expect(normalizeZone("Europe/Paris")).toBe(DEFAULT_TIME_ZONE);
    expect(normalizeZone("")).toBe(DEFAULT_TIME_ZONE);
    expect(normalizeZone(null)).toBe(DEFAULT_TIME_ZONE);
    expect(normalizeZone(undefined)).toBe(DEFAULT_TIME_ZONE);
  });
  it("default is Eastern and is a member of the id list", () => {
    expect(DEFAULT_TIME_ZONE).toBe("America/New_York");
    expect(US_TIME_ZONE_IDS).toContain(DEFAULT_TIME_ZONE);
  });
  it("every option value is in the id tuple", () => {
    for (const o of US_TIME_ZONES) expect(US_TIME_ZONE_IDS).toContain(o.value);
  });
});

describe("display.timeZone setting", () => {
  it("is registered as a select whose default is Eastern", () => {
    const def = SETTINGS.find((s) => s.key === "display.timeZone");
    expect(def).toBeDefined();
    expect(def!.input.type).toBe("select");
    expect(def!.envDefault()).toBe("America/New_York");
  });
});
