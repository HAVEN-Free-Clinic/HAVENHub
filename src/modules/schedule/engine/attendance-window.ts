/**
 * Whether the roster date currently selected on /schedule/full is the live
 * clinic day, by day-key comparison (YYYY-MM-DD strings compare correctly).
 *
 * Governs whether the full-schedule attendance overlay's WRITE controls (mark
 * present, undo) render. markPresent/undoAttendance always resolve their
 * target date via todaysClinicDate(now) inside attendance.ts -- they NEVER
 * act on whatever date the caller has selected. The full schedule's date
 * strip lets a director browse to any clinic date in the term, so without
 * this gate a write triggered from a non-today row would either no-op
 * (today isn't a clinic day) or silently land on today's attendance instead
 * of the browsed date's. The read-only "Here" badge is not gated by this: it
 * is safe to show attendance state for any date.
 *
 * selectedKey is null when fullSchedule could not resolve a date (no active
 * term, or a term with no clinic dates yet) -- always false in that case,
 * since there is nothing to write attendance against.
 */
export function isSelectedDateToday(selectedKey: string | null, todayKey: string): boolean {
  return selectedKey !== null && selectedKey === todayKey;
}
