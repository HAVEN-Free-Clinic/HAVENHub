import { describe, expect, it } from "vitest";
import { HISTORICAL_TERMS, resolveTermForDate, type TermWindow } from "./terms";

const historicalWindows: TermWindow[] = HISTORICAL_TERMS.map((spec) => ({
  id: spec.code,
  code: spec.code,
  startDate: spec.startDate,
  endDate: spec.endDate,
}));

const day = (iso: string) => new Date(`${iso}T12:00:00Z`);

describe("HISTORICAL_TERMS", () => {
  it("covers every meeting date the workbook holds before 2026", () => {
    // The real first and last columns of each pre-2026 grid, plus the pair that
    // straddle a boundary. A gap here means meetings silently drop out of the
    // import with nothing but a line in the unresolved list to show for it.
    for (const dateKey of [
      "2024-02-06",
      "2024-04-30",
      "2024-05-14",
      "2024-05-28",
      "2024-06-11",
      "2024-09-17",
      "2024-10-01",
      "2024-12-24",
      "2025-01-07",
      "2025-01-21",
      "2025-09-02",
      "2025-09-30",
      "2025-12-09",
    ]) {
      expect(resolveTermForDate(dateKey, historicalWindows), dateKey).not.toBeNull();
    }
  });

  it("does not overlap, so a historical date has exactly one term", () => {
    for (const dateKey of ["2024-05-29", "2024-05-30", "2024-09-26", "2024-09-27", "2025-01-11", "2025-01-12"]) {
      const containing = historicalWindows.filter(
        (w) => w.startDate <= day(dateKey) && day(dateKey) <= w.endDate,
      );
      expect(containing.length, dateKey).toBe(1);
    }
  });

  it("keeps the January meeting with the fall board that held it", () => {
    // 2025-01-07 is the last column of the 2024 grid, not the first of 2025.
    expect(resolveTermForDate("2025-01-07", historicalWindows)?.code).toBe("FA24");
    expect(resolveTermForDate("2025-01-21", historicalWindows)?.code).toBe("SP25");
  });
});

describe("resolveTermForDate", () => {
  it("returns null outside every window", () => {
    expect(resolveTermForDate("2023-06-01", historicalWindows)).toBeNull();
    expect(resolveTermForDate("2027-01-12", historicalWindows)).toBeNull();
  });

  it("prefers the earlier-starting term when live terms overlap", () => {
    // The live SU26 and FA26 rows overlap through September, because ops build
    // the next term before flipping to it. The board that met on September 8
    // was SU26's; FA26 was a roster being drafted.
    const overlapping: TermWindow[] = [
      { id: "su26", code: "SU26", startDate: day("2026-05-30"), endDate: day("2026-09-26") },
      { id: "fa26", code: "FA26", startDate: day("2026-09-01"), endDate: day("2027-01-01") },
    ];
    expect(resolveTermForDate("2026-09-08", overlapping)?.code).toBe("SU26");
    expect(resolveTermForDate("2026-10-06", overlapping)?.code).toBe("FA26");
  });

  it("includes both boundary days", () => {
    const single: TermWindow[] = [
      { id: "t", code: "T", startDate: day("2025-01-12"), endDate: day("2025-05-29") },
    ];
    expect(resolveTermForDate("2025-01-12", single)?.code).toBe("T");
    expect(resolveTermForDate("2025-05-29", single)?.code).toBe("T");
    expect(resolveTermForDate("2025-05-30", single)).toBeNull();
  });
});
