/**
 * Where a member goes to complete one EHS item, and what to call that place.
 *
 * EHS items are not all in one system: most are Workday Learning courses, but
 * the health requirements (TB baseline screening, HepB immunity assessment) are
 * completed in HealthOnTrack. A single "Complete EHS training in Workday" button
 * sent people to the wrong system for exactly the items that stall.
 *
 * The link comes from EhsTraining.completionUrl, which an admin sets per
 * training. No link means there is nothing for the member to go do: "Added to
 * EHS?" is a coordinator's record that Yale EHS has registered someone, and
 * pointing them at Workday to "complete" it is the same kind of misdirection
 * this whole surface exists to remove.
 *
 * Pure: no DB, no React.
 */

/** Hosts we can name in a CTA. Anything else gets a generic label. */
const SYSTEM_NAMES: readonly (readonly [host: string, name: string])[] = [
  ["healthontrack.yale.edu", "HealthOnTrack"],
  ["myworkday.com", "Workday"],
  ["myapps.ynhh.org", "Epic"],
];

/** The training's own link, or null when the member has nothing to go and do. */
export function ehsCompletionUrl(completionUrl: string | null | undefined): string | null {
  const trimmed = completionUrl?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

/** "HealthOnTrack" / "Workday" for a known host, else null. */
export function externalSystemName(url: string): string | null {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
  for (const [needle, name] of SYSTEM_NAMES) {
    if (host === needle || host.endsWith(`.${needle}`)) return name;
  }
  return null;
}

/** CTA label naming the destination, so "Complete" never means "guess where". */
export function ehsCompletionLabel(url: string): string {
  const name = externalSystemName(url);
  return name ? `Complete in ${name}` : "Complete";
}
