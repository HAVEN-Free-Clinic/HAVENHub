import { describe, expect, it } from "vitest";
import { parseCompletionDate, CompletionDateError } from "./completion-date";

describe("parseCompletionDate", () => {
  it("parses a valid date to noon UTC", () => {
    const target = new Date();
    target.setUTCFullYear(target.getUTCFullYear() - 2);
    const yyyy = target.getUTCFullYear();
    const mm = String(target.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(target.getUTCDate()).padStart(2, "0");
    const d = parseCompletionDate(`${yyyy}-${mm}-${dd}`);
    expect(d.getUTCFullYear()).toBe(yyyy);
    expect(d.getUTCMonth()).toBe(target.getUTCMonth());
    expect(d.getUTCDate()).toBe(target.getUTCDate());
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

  it("accepts today's date", () => {
    const now = new Date();
    const yyyy = now.getUTCFullYear();
    const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(now.getUTCDate()).padStart(2, "0");
    expect(() => parseCompletionDate(`${yyyy}-${mm}-${dd}`)).not.toThrow();
  });
});
