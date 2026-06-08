/**
 * Resolve a link to the current clinic week's Microsoft Teams channel.
 *
 * The clinic Team holds one channel per clinic week, each named "MM-DD-YY Clinic"
 * (e.g. "06-13-26 Clinic"). We compute the current clinic date from the active
 * term's clinicDates (America/New_York calendar; a clinic Saturday's channel
 * shows through that Saturday and rolls to the next at midnight into Sunday),
 * list the Team's channels via Microsoft Graph using the reused Mailer delegated
 * token, and return the matched channel's Graph-provided webUrl deeplink.
 *
 * Every failure path degrades to null so the dashboard simply hides the card.
 */

/** A Microsoft Graph channel object (subset we use). */
export interface GraphChannel {
  id: string;
  displayName: string;
  webUrl: string;
}

/**
 * Return the YYYYMMDD integer for the America/New_York calendar date of an
 * instant. Clinic dates are anchored at 12:00 UTC, so their NY calendar date is
 * unambiguous; "now" is converted to its NY calendar date for comparison.
 */
function nyDateInt(d: Date): number {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(d);
  const y = parts.find((p) => p.type === "year")!.value;
  const m = parts.find((p) => p.type === "month")!.value;
  const day = parts.find((p) => p.type === "day")!.value;
  return Number(`${y}${m}${day}`);
}

/**
 * Pick the earliest clinic date whose NY calendar date is >= today's NY calendar
 * date. Returns null when there is no upcoming clinic date.
 */
export function selectCurrentClinicDate(
  clinicDates: Date[],
  now: Date
): Date | null {
  const today = nyDateInt(now);
  const upcoming = clinicDates
    .filter((d) => nyDateInt(d) >= today)
    .sort((a, b) => a.getTime() - b.getTime());
  return upcoming[0] ?? null;
}

/** Format a clinic date as zero-padded MM-DD-YY in America/New_York. */
export function formatClinicDate(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "2-digit",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const m = parts.find((p) => p.type === "month")!.value;
  const d = parts.find((p) => p.type === "day")!.value;
  const y = parts.find((p) => p.type === "year")!.value;
  return `${m}-${d}-${y}`;
}

/**
 * Find the channel whose displayName starts with the MM-DD-YY date string
 * (trim + case-insensitive). Returns null when none match.
 */
export function matchChannel(
  channels: GraphChannel[],
  dateStr: string
): GraphChannel | null {
  const target = dateStr.trim().toLowerCase();
  return (
    channels.find((c) =>
      (c.displayName ?? "").trim().toLowerCase().startsWith(target)
    ) ?? null
  );
}
