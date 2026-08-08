/**
 * Pure derivation of attendance outcomes from assignments plus attendance rows.
 *
 * Absence is NEVER stored. An assignment with no attendance row on a clinic date
 * strictly BEFORE today is a no-show; on today or later it is simply pending.
 * That boundary is why today's clinic is not scored as a wall of absences at
 * 9am, and why nothing has to be backfilled when a clinic day ends.
 *
 * Keys are YYYY-MM-DD display-zone day keys, which compare correctly as strings.
 */

export type AttendanceOutcome = "PRESENT" | "NO_SHOW" | "PENDING";

export function classifyAssignment(input: {
  clinicDateKey: string;
  todayKey: string;
  hasAttendance: boolean;
}): AttendanceOutcome {
  if (input.hasAttendance) return "PRESENT";
  return input.clinicDateKey < input.todayKey ? "NO_SHOW" : "PENDING";
}

export function summarize(
  rows: Array<{ clinicDateKey: string; hasAttendance: boolean }>,
  todayKey: string,
): { present: number; noShow: number; pending: number; noShowRate: number | null } {
  let present = 0;
  let noShow = 0;
  let pending = 0;

  for (const row of rows) {
    switch (classifyAssignment({ ...row, todayKey })) {
      case "PRESENT":
        present += 1;
        break;
      case "NO_SHOW":
        noShow += 1;
        break;
      default:
        pending += 1;
    }
  }

  // Rate is over DECIDED assignments only. Including pending ones would make a
  // volunteer's record improve simply because more future shifts were scheduled.
  const decided = present + noShow;
  return { present, noShow, pending, noShowRate: decided === 0 ? null : noShow / decided };
}
