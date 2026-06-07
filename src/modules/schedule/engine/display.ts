/**
 * Date display utilities for the schedule engine.
 *
 * Ported from the legacy HAVEN scheduler on 2026-06-07; semantics unchanged.
 * Only displayDate, SUFFIX, and MONTH_NAMES were ported. The flexible date
 * parser and CANONICAL_DATES were retired with the legacy free-text availability
 * system and are not included here.
 */

const SUFFIX = (day: number): string => {
  if (day >= 11 && day <= 13) return "th";
  switch (day % 10) {
    case 1: return "st";
    case 2: return "nd";
    case 3: return "rd";
    default: return "th";
  }
};

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/**
 * Formats an ISO date string (YYYY-MM-DD) as a human-readable string,
 * e.g. "2026-07-04" -> "July 4th".
 */
export function displayDate(iso: string): string {
  const [, m, d] = iso.split("-").map(Number);
  return `${MONTH_NAMES[m - 1]} ${d}${SUFFIX(d)}`;
}
