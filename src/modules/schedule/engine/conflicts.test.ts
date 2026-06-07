import { describe, expect, it } from "vitest";
import { computeConflicts, type ScheduleEntry } from "./conflicts";

// Helper: build a ScheduleEntry with departmentId === departmentName for brevity.
const entry = (
  date: string,
  dept: string,
  directorIds: string[],
  volunteerIds: string[],
): ScheduleEntry => ({ date, departmentId: dept, departmentName: dept, directorIds, volunteerIds });

describe("computeConflicts", () => {
  it("returns empty conflicts for a person with one assignment", () => {
    const conflicts = computeConflicts({
      personId: "p1",
      thisDepartmentId: "LABR",
      allSchedule: [entry("2026-05-30", "LABR", ["p1"], [])],
    });
    expect(conflicts.sameDay).toEqual([]);
    expect(conflicts.crossTerm).toEqual([]);
  });

  it("flags same-day conflict across departments", () => {
    const conflicts = computeConflicts({
      personId: "p1",
      thisDepartmentId: "LABR",
      allSchedule: [
        entry("2026-05-30", "LABR", ["p1"], []),
        entry("2026-05-30", "JCTS", [], ["p1"]),
      ],
    });
    expect(conflicts.sameDay).toEqual([{ date: "2026-05-30", otherDept: "JCTS" }]);
    expect(conflicts.crossTerm).toEqual([]);
  });

  it("flags cross-term conflict on different dates", () => {
    const conflicts = computeConflicts({
      personId: "p1",
      thisDepartmentId: "LABR",
      allSchedule: [
        entry("2026-05-30", "LABR", ["p1"], []),
        entry("2026-06-06", "JCTS", [], ["p1"]),
      ],
    });
    expect(conflicts.sameDay).toEqual([]);
    expect(conflicts.crossTerm).toEqual([{ date: "2026-06-06", otherDept: "JCTS" }]);
  });

  it("does not flag the person's assignments in their own department", () => {
    const conflicts = computeConflicts({
      personId: "p1",
      thisDepartmentId: "LABR",
      allSchedule: [
        entry("2026-05-30", "LABR", ["p1"], []),
        entry("2026-06-06", "LABR", [], ["p1"]),
      ],
    });
    expect(conflicts.sameDay).toEqual([]);
    expect(conflicts.crossTerm).toEqual([]);
  });

  it("deduplicates multiple appearances in the same other dept", () => {
    const conflicts = computeConflicts({
      personId: "p1",
      thisDepartmentId: "LABR",
      allSchedule: [
        entry("2026-05-30", "LABR", ["p1"], []),
        entry("2026-05-30", "JCTS", ["p1"], []),
        entry("2026-05-30", "JCTS", [], ["p1"]),
      ],
    });
    expect(conflicts.sameDay).toEqual([{ date: "2026-05-30", otherDept: "JCTS" }]);
  });

  it("counts shadow assignments for same-day conflict detection", () => {
    const scheduleWithShadow: ScheduleEntry[] = [
      { date: "2026-06-06", departmentId: "LABR", departmentName: "LABR", directorIds: [], volunteerIds: [], shadowIds: ["p1"] },
      { date: "2026-06-06", departmentId: "JCTS", departmentName: "JCTS", directorIds: [], volunteerIds: ["p1"] },
    ];
    const conflicts = computeConflicts({
      personId: "p1",
      thisDepartmentId: "LABR",
      allSchedule: scheduleWithShadow,
    });
    expect(conflicts.sameDay).toEqual([{ date: "2026-06-06", otherDept: "JCTS" }]);
    expect(conflicts.crossTerm).toEqual([]);
  });

  it("sorts output by date then by department name", () => {
    const conflicts = computeConflicts({
      personId: "p1",
      thisDepartmentId: "LABR",
      allSchedule: [
        entry("2026-05-30", "LABR", ["p1"], []),
        entry("2026-06-06", "ZZZZ", [], ["p1"]),
        entry("2026-06-06", "AAAA", [], ["p1"]),
      ],
    });
    expect(conflicts.crossTerm[0].otherDept).toBe("AAAA");
    expect(conflicts.crossTerm[1].otherDept).toBe("ZZZZ");
  });
});
