/**
 * Chronological ordering for clinic dates, shared by every presentation
 * component that renders or groups `Term.clinicDates`.
 *
 * `Term.clinicDates` is a raw Postgres array column with no ordering
 * guarantee, and the clinic check-in feature's seed appends today's date to
 * the end regardless of where it falls chronologically. A real seeded term
 * can therefore store, e.g., `... 2026-09-12, 2026-09-19, 2026-09-26,
 * 2026-08-07`. Every consumer must sort a COPY before rendering or grouping
 * -- never the array itself: `fullSchedule()` and `builderView()` return
 * `term.clinicDates` by reference, and the Builder page hands that same
 * array object to several components in one request, so an in-place sort
 * would silently reorder it for every other consumer.
 */

import { isoDateKey, formatCalendarDate } from "@/platform/dates";

/** Returns a new array of `dates` sorted ascending. Does not mutate `dates`. */
export function sortClinicDates(dates: Date[]): Date[] {
  return [...dates].sort((a, b) => a.getTime() - b.getTime());
}

export type MonthGroup = { key: string; month: string; dates: Date[] };

/**
 * Groups dates into runs of the same calendar month, sorting a copy
 * ascending first so the runs come out chronological and contiguous
 * regardless of the input order. Each group is keyed on its first date's
 * ISO key rather than the month label, so that even if two runs ever did
 * land on the same month (a bug elsewhere, a future caller, ...), callers
 * mapping this into React elements would still see distinct keys instead of
 * a collision, and no two groups can ever share a heading.
 */
export function groupByMonth(dates: Date[]): MonthGroup[] {
  const sorted = sortClinicDates(dates);
  const groups: MonthGroup[] = [];
  for (const date of sorted) {
    const month = formatCalendarDate(date, { month: "long", year: "numeric" });
    const last = groups[groups.length - 1];
    if (last && last.month === month) last.dates.push(date);
    else groups.push({ key: isoDateKey(date), month, dates: [date] });
  }
  return groups;
}
