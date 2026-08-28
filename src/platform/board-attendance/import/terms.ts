/**
 * Which term a historical board meeting belongs to.
 *
 * BoardMeeting.termId is required, and the workbook reaches back to February
 * 2024 while the hub only holds terms from SP26 on. The missing terms are
 * therefore minted here, ARCHIVED, purely so the meetings that happened in them
 * have somewhere to hang.
 *
 * Creating them ARCHIVED is what makes this safe, and it is the same reasoning
 * platform/airtable/import/historical-term.ts spells out at length: every
 * permission-, roster-, schedule- and compliance-bearing query scopes its
 * TermMembership lookups to the ACTIVE term, so an ACTIVE membership in an
 * ARCHIVED term reads as "this person served this term" and grants nothing.
 */

/** Noon UTC, the convention every date marker in this schema uses. */
function day(iso: string): Date {
  return new Date(`${iso}T12:00:00Z`);
}

export type HistoricalTermSpec = {
  code: string;
  name: string;
  startDate: Date;
  endDate: Date;
};

/**
 * The terms the workbook needs that the hub does not have.
 *
 * The boundaries mirror the shape ops set for 2026 (SP26 runs Jan 12 to May 29,
 * SU26 May 30 to Sep 26) shifted back a year at a time, with fall closing the
 * gap into January. Unlike the live terms these do not overlap: a historical
 * meeting has exactly one term it can belong to, and the overlap the live SU26
 * and FA26 rows carry is ops running a planning term ahead of the flip, not a
 * statement about when a board actually sat.
 *
 * Fall running into January is deliberate and matches the sheet: the January 7
 * 2025 meeting is the last column of the 2024 grid and the last meeting of that
 * board, not the first of the next one.
 */
export const HISTORICAL_TERMS: HistoricalTermSpec[] = [
  { code: "SP24", name: "Spring 2024", startDate: day("2024-01-12"), endDate: day("2024-05-29") },
  { code: "SU24", name: "Summer 2024", startDate: day("2024-05-30"), endDate: day("2024-09-26") },
  { code: "FA24", name: "Fall 2024", startDate: day("2024-09-27"), endDate: day("2025-01-11") },
  { code: "SP25", name: "Spring 2025", startDate: day("2025-01-12"), endDate: day("2025-05-29") },
  { code: "SU25", name: "Summer 2025", startDate: day("2025-05-30"), endDate: day("2025-09-26") },
  { code: "FA25", name: "Fall 2025", startDate: day("2025-09-27"), endDate: day("2026-01-11") },
];

export type TermWindow = { id: string; code: string; startDate: Date; endDate: Date };

/**
 * The term whose window contains a meeting date, or null.
 *
 * Live terms can overlap (SU26 ends Sep 26 while FA26 already starts Sep 1,
 * because ops build the next term before flipping to it). When they do, the
 * earlier-starting term wins: on September 8 the board sitting was SU26's, and
 * FA26 was a roster being drafted, not a term anybody had met in yet.
 */
export function resolveTermForDate(dateKey: string, terms: TermWindow[]): TermWindow | null {
  const date = day(dateKey).getTime();
  const containing = terms.filter(
    (t) => t.startDate.getTime() <= date && date <= t.endDate.getTime(),
  );
  if (containing.length === 0) return null;
  return containing.sort((a, b) => a.startDate.getTime() - b.startDate.getTime())[0];
}
