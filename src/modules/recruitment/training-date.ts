/** Formats the cycle's training date for interpolation into agreement prose.
 *  The zone comes from the configured display timezone (see src/platform/dates),
 *  not the server's, so everyone reads the same wall-clock date. inPersonTrainingDate
 *  is a date-only value (stored at noon UTC, see src/app/(app)/recruitment/actions.ts),
 *  so this renders only the calendar date -- no time of day, which lives in
 *  trainingLocation instead. */
export function formatTrainingDate(at: Date | null, zone: string): string {
  if (!at) return "the scheduled training date";
  return new Intl.DateTimeFormat("en-US", {
    weekday: "long", month: "long", day: "numeric", timeZone: zone,
  }).format(at);
}

/** Leading space so "{{trainingDate}}{{trainingLocation}}" reads correctly with
 *  or without a location. */
export function formatTrainingLocation(loc: string | null): string {
  const trimmed = loc?.trim();
  return trimmed ? ` ${trimmed}` : "";
}
