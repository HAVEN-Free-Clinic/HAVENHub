import { describe, expect, it } from "vitest";
import { formatPhone } from "./phone";

describe("formatPhone", () => {
  it("formats the shapes a US number is typed in", () => {
    for (const raw of ["4087075782", "408-707-5782", "(408) 707-5782", "408.707.5782", " 408 707 5782 "]) {
      expect(formatPhone(raw)).toBe("(408) 707-5782");
    }
  });

  it("drops a leading country code 1", () => {
    expect(formatPhone("14087075782")).toBe("(408) 707-5782");
    expect(formatPhone("+1 408 707 5782")).toBe("(408) 707-5782");
    expect(formatPhone("1-408-707-5782")).toBe("(408) 707-5782");
  });

  it("keeps an extension", () => {
    expect(formatPhone("203-555-0131 x12")).toBe("(203) 555-0131 ext. 12");
    expect(formatPhone("2035550131 ext. 4")).toBe("(203) 555-0131 ext. 4");
    expect(formatPhone("(203) 555-0131 Extension 900")).toBe("(203) 555-0131 ext. 900");
  });

  it("returns an unrecognised shape as typed rather than guessing", () => {
    expect(formatPhone("+44 20 7946 0958")).toBe("+44 20 7946 0958");
    expect(formatPhone("555-0131")).toBe("555-0131");
    expect(formatPhone("1-800-FLOWERS")).toBe("1-800-FLOWERS");
    expect(formatPhone("  call the front desk ")).toBe("call the front desk");
  });

  it("returns null for nothing, so callers keep their own empty state", () => {
    expect(formatPhone(null)).toBeNull();
    expect(formatPhone(undefined)).toBeNull();
    expect(formatPhone("")).toBeNull();
    expect(formatPhone("   ")).toBeNull();
  });
});
