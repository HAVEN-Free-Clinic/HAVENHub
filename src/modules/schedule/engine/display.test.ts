import { describe, expect, it } from "vitest";
import { displayDate } from "./display";

/**
 * These cases used to enumerate the ordinal suffix table ("July 4th", "July
 * 21st", the 11/12/13 teens exception). That table is gone: displayDate now
 * delegates to CLINIC_DATE_SHORT, so what is worth pinning is the shape of the
 * output and the noon-UTC anchor that keeps it off the previous day.
 */
describe("displayDate", () => {
  it("renders the clinic short form: abbreviated month, no ordinal, no year", () => {
    expect(displayDate("2026-07-04")).toBe("Jul 4");
    expect(displayDate("2026-09-12")).toBe("Sep 12");
    expect(displayDate("2026-02-07")).toBe("Feb 7");
  });

  it("does not slip to the previous day", () => {
    // formatCalendarDate formats in UTC. A midnight anchor is one rounding away
    // from December 31; the noon anchor inside displayDate is what prevents it.
    expect(displayDate("2026-01-01")).toBe("Jan 1");
    expect(displayDate("2026-12-31")).toBe("Dec 31");
  });
});
