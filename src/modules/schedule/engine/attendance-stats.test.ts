import { describe, it, expect } from "vitest";
import { classifyAssignment, summarize } from "./attendance-stats";

const TODAY = "2026-03-07";

describe("classifyAssignment", () => {
  it("is PRESENT when an attendance row exists, whatever the date", () => {
    expect(classifyAssignment({ clinicDateKey: "2026-02-28", todayKey: TODAY, hasAttendance: true })).toBe("PRESENT");
    expect(classifyAssignment({ clinicDateKey: TODAY, todayKey: TODAY, hasAttendance: true })).toBe("PRESENT");
    expect(classifyAssignment({ clinicDateKey: "2026-03-14", todayKey: TODAY, hasAttendance: true })).toBe("PRESENT");
  });

  it("is NO_SHOW only for a PAST date with no attendance", () => {
    expect(classifyAssignment({ clinicDateKey: "2026-02-28", todayKey: TODAY, hasAttendance: false })).toBe("NO_SHOW");
  });

  it("is PENDING for today with no attendance, so a 9am clinic is not scored as absences", () => {
    expect(classifyAssignment({ clinicDateKey: TODAY, todayKey: TODAY, hasAttendance: false })).toBe("PENDING");
  });

  it("is PENDING for a future date", () => {
    expect(classifyAssignment({ clinicDateKey: "2026-03-14", todayKey: TODAY, hasAttendance: false })).toBe("PENDING");
  });
});

describe("summarize", () => {
  it("counts each bucket and rates no-shows over decided assignments only", () => {
    const result = summarize(
      [
        { clinicDateKey: "2026-02-21", hasAttendance: true },
        { clinicDateKey: "2026-02-28", hasAttendance: false },
        { clinicDateKey: TODAY, hasAttendance: false },
        { clinicDateKey: "2026-03-14", hasAttendance: false },
      ],
      TODAY,
    );
    expect(result.present).toBe(1);
    expect(result.noShow).toBe(1);
    expect(result.pending).toBe(2);
    // 1 no-show out of 2 decided (present + noShow), NOT out of 4.
    expect(result.noShowRate).toBe(0.5);
  });

  it("returns a null rate when nothing has been decided yet", () => {
    const result = summarize([{ clinicDateKey: "2026-03-14", hasAttendance: false }], TODAY);
    expect(result.noShowRate).toBeNull();
  });

  it("handles an empty input", () => {
    expect(summarize([], TODAY)).toEqual({ present: 0, noShow: 0, pending: 0, noShowRate: null });
  });
});
