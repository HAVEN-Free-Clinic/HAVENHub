/**
 * Comparing Term.startDate / Term.endDate against "now".
 *
 * Both are noon-UTC CALENDAR MARKERS, not instants (see toNoonUtc in
 * src/modules/admin/services/terms.ts): "SU26 ends 2026-08-31" is stored as
 * 2026-08-31T12:00:00Z. Comparing one of those against a raw `new Date()`
 * therefore answers a question nobody asked, and it answers it wrong for most
 * of the day: a term ending today reads as ALREADY ENDED from 08:00 ET onwards,
 * which revoked live wallet badges and refused to issue new ones for the whole
 * of a term's final clinic day, and made a term that starts today count as
 * not-yet-started until mid-morning (audit 14).
 *
 * The fix is to compare marker to marker. `todayMarker()` resolves the
 * DISPLAY-ZONE calendar day (what day it is at the clinic right now, which is
 * what a term date means to the people who set it) and anchors it at noon UTC,
 * exactly as a term date is anchored. Then `endDate < todayMarker` reads as "an
 * earlier calendar day" with no time-of-day component on either side, which is
 * how the rest of the codebase compares these values (see withinTerm in
 * src/modules/schedule/services/builder.ts).
 */

import { displayTodayKey } from "@/platform/dates/today";

/**
 * Today's calendar day in the display zone, as a noon-UTC marker directly
 * comparable with Term.startDate / Term.endDate.
 */
export async function todayMarker(now: Date = new Date()): Promise<Date> {
  return new Date(`${await displayTodayKey(now)}T12:00:00Z`);
}
