/**
 * Date display for the schedule engine.
 *
 * Ported from the legacy HAVEN scheduler on 2026-06-07. The ordinal form it
 * brought with it ("July 4th") was retired in the clinic-date cleanup: it was
 * the eighth way one Saturday got written, and it sat two lines under a card
 * headline that said "Feb 7, 2026". Every one of the ten callers renders the
 * date as ONE ITEM AMONG MANY (a grid column, a date pill, a swap-partner
 * option), which is exactly what CLINIC_DATE_SHORT is for, so the function
 * stays and only its output moves.
 */
import { CLINIC_DATE_SHORT, formatCalendarDate } from "@/platform/dates";

/**
 * Formats an ISO date string (YYYY-MM-DD) as a clinic date,
 * e.g. "2026-07-04" -> "Jul 4".
 *
 * Precondition: iso must be a valid YYYY-MM-DD string (callers pass
 * isoDateKey output). Garbage input is undefined behavior, not validated.
 *
 * Anchored at noon UTC, the same trick schedule/builder/page.tsx uses on the
 * same kind of key: formatCalendarDate formats in UTC, so a midnight anchor
 * would be one rounding away from the previous day.
 */
export function displayDate(iso: string): string {
  return formatCalendarDate(new Date(`${iso}T12:00:00Z`), CLINIC_DATE_SHORT);
}
