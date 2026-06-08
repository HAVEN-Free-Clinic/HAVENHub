import { describe, expect, it } from "vitest";
import { isoDateKey, toScheduleEntries, type AssignmentRow } from "./map";

// All tests use UTC dates explicitly to avoid timezone surprises.
function utc(year: number, month: number, day: number, hour = 0): Date {
  return new Date(Date.UTC(year, month - 1, day, hour, 0, 0, 0));
}

describe("isoDateKey", () => {
  it("returns YYYY-MM-DD for a date at midnight UTC", () => {
    expect(isoDateKey(utc(2026, 7, 4))).toBe("2026-07-04");
  });

  it("returns the same UTC day for a date at 12:00Z", () => {
    expect(isoDateKey(utc(2026, 7, 4, 12))).toBe("2026-07-04");
  });

  it("returns the same UTC day for a date at 23:30Z (stays on same day)", () => {
    const d = new Date(Date.UTC(2026, 6, 4, 23, 30, 0, 0));
    expect(isoDateKey(d)).toBe("2026-07-04");
  });

  it("pads month and day with leading zeroes", () => {
    expect(isoDateKey(utc(2026, 1, 5))).toBe("2026-01-05");
  });
});

describe("toScheduleEntries", () => {
  it("returns empty array for empty input", () => {
    expect(toScheduleEntries([])).toEqual([]);
  });

  it("groups rows by (date, departmentId)", () => {
    const rows: AssignmentRow[] = [
      { departmentId: "LABR", departmentName: "Labor & Delivery", personId: "p1", clinicDate: utc(2026, 7, 4), role: "DIRECTOR" },
      { departmentId: "LABR", departmentName: "Labor & Delivery", personId: "p2", clinicDate: utc(2026, 7, 4), role: "VOLUNTEER" },
    ];
    const entries = toScheduleEntries(rows);
    expect(entries).toHaveLength(1);
    expect(entries[0].date).toBe("2026-07-04");
    expect(entries[0].departmentId).toBe("LABR");
  });

  it("splits roles into correct arrays", () => {
    const rows: AssignmentRow[] = [
      { departmentId: "LABR", departmentName: "Labor & Delivery", personId: "dir1", clinicDate: utc(2026, 7, 4), role: "DIRECTOR" },
      { departmentId: "LABR", departmentName: "Labor & Delivery", personId: "vol1", clinicDate: utc(2026, 7, 4), role: "VOLUNTEER" },
      { departmentId: "LABR", departmentName: "Labor & Delivery", personId: "shad1", clinicDate: utc(2026, 7, 4), role: "SHADOW" },
    ];
    const [entry] = toScheduleEntries(rows);
    expect(entry.directorIds).toEqual(["dir1"]);
    expect(entry.volunteerIds).toEqual(["vol1"]);
    expect(entry.shadowIds).toEqual(["shad1"]);
  });

  it("omits shadowIds when no shadow rows exist", () => {
    const rows: AssignmentRow[] = [
      { departmentId: "LABR", departmentName: "Labor & Delivery", personId: "dir1", clinicDate: utc(2026, 7, 4), role: "DIRECTOR" },
    ];
    const [entry] = toScheduleEntries(rows);
    expect(entry.shadowIds).toBeUndefined();
  });

  it("groups across two dates and two departments into four entries", () => {
    const rows: AssignmentRow[] = [
      { departmentId: "LABR", departmentName: "Labor", personId: "p1", clinicDate: utc(2026, 7, 4), role: "DIRECTOR" },
      { departmentId: "JCTS", departmentName: "JCTS", personId: "p2", clinicDate: utc(2026, 7, 4), role: "VOLUNTEER" },
      { departmentId: "LABR", departmentName: "Labor", personId: "p3", clinicDate: utc(2026, 7, 11), role: "VOLUNTEER" },
      { departmentId: "JCTS", departmentName: "JCTS", personId: "p4", clinicDate: utc(2026, 7, 11), role: "DIRECTOR" },
    ];
    const entries = toScheduleEntries(rows);
    expect(entries).toHaveLength(4);
  });

  it("sorts entries by date ascending, then by departmentName ascending", () => {
    const rows: AssignmentRow[] = [
      { departmentId: "ZZZZ", departmentName: "Zzz Dept", personId: "p1", clinicDate: utc(2026, 7, 4), role: "DIRECTOR" },
      { departmentId: "AAAA", departmentName: "Aaa Dept", personId: "p2", clinicDate: utc(2026, 7, 4), role: "DIRECTOR" },
      { departmentId: "LABR", departmentName: "Labor", personId: "p3", clinicDate: utc(2026, 7, 11), role: "DIRECTOR" },
    ];
    const entries = toScheduleEntries(rows);
    expect(entries[0].departmentName).toBe("Aaa Dept");
    expect(entries[1].departmentName).toBe("Zzz Dept");
    expect(entries[2].date).toBe("2026-07-11");
  });
});
