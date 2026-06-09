import { describe, expect, it } from "vitest";
import { isValidCron, nextCronAfter } from "./cron";

describe("cron utility", () => {
  it("validates cron expressions", () => {
    expect(isValidCron("0 13 * * 1")).toBe(true);
    expect(isValidCron("not a cron")).toBe(false);
    expect(isValidCron("")).toBe(false);
  });

  it("computes the next occurrence strictly after the given time (UTC)", () => {
    const after = new Date("2026-06-10T12:00:00Z");
    expect(nextCronAfter("0 13 * * *", after).toISOString()).toBe("2026-06-10T13:00:00.000Z");
    const after2 = new Date("2026-06-10T13:00:00Z");
    expect(nextCronAfter("0 13 * * *", after2).toISOString()).toBe("2026-06-11T13:00:00.000Z");
  });

  it("throws on an invalid expression in nextCronAfter", () => {
    expect(() => nextCronAfter("nope", new Date())).toThrow();
  });
});
