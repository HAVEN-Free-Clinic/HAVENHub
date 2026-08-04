// Composes the settings-resolved display zone (resolve.ts) with pure
// formatting (format.ts) to answer "what day is it, for display purposes,
// right now?". Deliberately not re-exported from ./index: index.ts is the
// client-safe barrel (zone.ts + format.ts + the pure parts of logic.ts), and
// resolve.ts pulls in the settings service (Prisma, React cache), which must
// stay out of anything a "use client" component can import.
import { getDisplayTimeZone } from "./resolve";
import { formatForDateInput } from "./format";

/**
 * The display-zone calendar day, as a YYYY-MM-DD key, for `now` (defaults to
 * the current instant).
 *
 * "Today" is the display-zone (ET) calendar day: a raw isoDateKey(new Date())
 * is a UTC day key that rolls over at ~8pm ET, so for the last few hours of
 * every calendar day it would resolve to tomorrow instead of today.
 */
export async function displayTodayKey(now: Date = new Date()): Promise<string> {
  return formatForDateInput(now, await getDisplayTimeZone());
}
