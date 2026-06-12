import { describe, expect, it } from "vitest";
import { parseCompletionDate, CompletionDateError } from "./completion-date";

describe("parseCompletionDate", () => {
  it("parses a valid date to noon UTC", () => {
    const d = parseCompletionDate("2025-06-01");
    expect(d.getUTCFullYear()).toBe(2025);
    expect(d.getUTCMonth()).toBe(5); // June = 5
    expect(d.getUTCDate()).toBe(1);
    expect(d.getUTCHours()).toBe(12);
  });

  it("rejects a malformed string", () => {
    expect(() => parseCompletionDate("06/01/2025")).toThrow(CompletionDateError);
  });

  it("rejects a calendar-overflow date (Feb 30)", () => {
    expect(() => parseCompletionDate("2025-02-30")).toThrow(CompletionDateError);
  });

  it("rejects a future date", () => {
    const nextYear = new Date().getUTCFullYear() + 1;
    expect(() => parseCompletionDate(`${nextYear}-01-01`)).toThrow(CompletionDateError);
  });

  it("rejects a date older than 5 years", () => {
    const old = new Date().getUTCFullYear() - 6;
    expect(() => parseCompletionDate(`${old}-01-01`)).toThrow(CompletionDateError);
  });

  it("exposes a reason on the error", () => {
    try {
      parseCompletionDate("not-a-date");
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(CompletionDateError);
      expect(typeof (err as CompletionDateError).reason).toBe("string");
    }
  });
});
