import { describe, expect, it } from "vitest";
import { parseAttendanceSheet, readStatus } from "./parse";

const d = (iso: string) => new Date(`${iso}T00:00:00Z`);

describe("readStatus", () => {
  it("reads the three plain spellings", () => {
    expect(readStatus("Present")).toEqual({ status: "PRESENT", note: null });
    expect(readStatus("Excused")).toEqual({ status: "EXCUSED", note: null });
    expect(readStatus("Absent")).toEqual({ status: "ABSENT", note: null });
  });

  it("is case insensitive and tolerates the sheet's trailing spaces", () => {
    expect(readStatus("present ")).toEqual({ status: "PRESENT", note: null });
    expect(readStatus("PRESENT")).toEqual({ status: "PRESENT", note: null });
  });

  it('reads the 2024 sheet\'s "here"', () => {
    expect(readStatus("here")).toEqual({ status: "PRESENT", note: null });
  });

  it("keeps a qualifier as the note", () => {
    expect(readStatus("Excused (illness)")).toEqual({ status: "EXCUSED", note: "illness" });
  });

  it("reads a present-then-left cell as PRESENT, not EXCUSED", () => {
    // Both spellings are real cells in the 2024 sheet. Reading them as EXCUSED
    // would be the cautious-looking choice and the wrong one: the director was
    // in the room, and only ABSENT feeds the strike count.
    expect(readStatus("Present [Excused after 12:00 PM]")).toEqual({
      status: "PRESENT",
      note: "Excused after 12:00 PM",
    });
    expect(readStatus("Present; Excused after 12:30 PM")).toEqual({
      status: "PRESENT",
      note: "Excused after 12:30 PM",
    });
  });

  it("refuses anything it does not recognize rather than guessing", () => {
    expect(readStatus("maybe")).toBeNull();
    expect(readStatus("n/a")).toBeNull();
    expect(readStatus("")).toBeNull();
    expect(readStatus("   ")).toBeNull();
  });
});

describe("parseAttendanceSheet", () => {
  const rows: unknown[][] = [
    ["Department", "Name", d("2025-01-07"), d("2025-01-21"), d("2025-02-04")],
    ["Behavioral Health", "Yash Wadwekar", "Present", "Excused", null],
    ["LCC", "Gretchen Long", "present", null, null],
    [null, null, null, null, null],
  ];

  it("reads names, departments and marks", () => {
    const parse = parseAttendanceSheet("Board Attendance - 2025", rows);
    expect(parse.rows).toHaveLength(2);
    expect(parse.rows[0]).toMatchObject({ name: "Yash Wadwekar", departmentLabel: "Behavioral Health", row: 2 });
    expect(parse.rows[0].marks).toEqual([
      { dateKey: "2025-01-07", status: "PRESENT", note: null, raw: "Present" },
      { dateKey: "2025-01-21", status: "EXCUSED", note: null, raw: "Excused" },
    ]);
  });

  it("separates date columns nobody was marked in", () => {
    const parse = parseAttendanceSheet("Board Attendance - 2025", rows);
    expect(parse.dateKeys).toEqual(["2025-01-07", "2025-01-21"]);
    // 2025-02-04 is a scheduled column nobody filled in. It must not become a
    // meeting: an empty meeting reads in the UI as "not yet recorded", which
    // for a column that was never taken is a different claim than the truth.
    expect(parse.emptyDateKeys).toEqual(["2025-02-04"]);
  });

  it("ignores a non-date header column and names it", () => {
    const parse = parseAttendanceSheet("Board Meeting- Attendance 2024", [
      ["Department", "Full Name", d("2024-02-06"), "25-Feb Strategic Retreat"],
      ["Lab", "Justin Zhu", "Absent", "Excused"],
    ]);
    expect(parse.dateKeys).toEqual(["2024-02-06"]);
    expect(parse.ignoredColumns).toEqual(["25-Feb Strategic Retreat"]);
    expect(parse.rows[0].marks).toHaveLength(1);
  });

  it("collects unreadable cells instead of dropping them silently", () => {
    const parse = parseAttendanceSheet("s", [
      ["Department", "Name", d("2025-01-07")],
      ["Lab", "Someone", "??"],
    ]);
    expect(parse.rows[0].marks).toEqual([]);
    expect(parse.unreadableCells).toEqual([
      { row: 2, name: "Someone", dateKey: "2025-01-07", text: "??" },
    ]);
  });

  it("collapses the double space the sheet writes in some names", () => {
    const parse = parseAttendanceSheet("s", [
      ["Department", "Name", d("2026-02-10")],
      ["Education", "Johnny  Yue", "Present"],
    ]);
    expect(parse.rows[0].name).toBe("Johnny Yue");
  });
});
