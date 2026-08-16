/**
 * The service record's SHAPE and its pure formatters.
 *
 * Split from ./service-record because this half is CLIENT-SAFE and that half is
 * not. The certificate PDF renders through a "use client" card, so every runtime
 * value it imports lands in the browser bundle along with that module's whole
 * import graph, which for ./service-record means prisma and (through
 * verifiedLanguagesByPerson) the notification sender.
 *
 * That combination fails only at `next build`, with an error about "after" in
 * flush-on-enqueue that names neither this module nor the PDF. Typecheck and
 * vitest both pass. Keep server imports out of this file.
 *
 * ./service-record re-exports everything here, so existing server callers are
 * unaffected and can keep importing from one place.
 */

export type ServiceTermRow = {
  termCode: string;
  termName: string;
  /** ISO string. JSON-safe: this value crosses into client components. */
  startDate: string;
  departmentName: string;
  track: "VOLUNTEER" | "DIRECTOR";
  /**
   * null = this term and department have no shift records at all. 0 = they do,
   * and this member had none there.
   */
  shifts: number | null;
  /**
   * Clinic dates served, ascending ISO day keys. null carries the same meaning
   * as `shifts: null` (we were not counting); [] means we were, and they served
   * none. Optional so an already-issued credential snapshot, which predates this
   * field, still parses.
   */
  dates?: string[] | null;
  /**
   * shifts x the department's hoursPerShift. null whenever either is unknown,
   * INCLUDING when the department has no hours configured. Never defaulted.
   * Optional for the same snapshot-compatibility reason as `dates`.
   */
  hours?: number | null;
  source: "MEMBERSHIP" | "RECRUITMENT";
};

export type ServiceRecord = {
  name: string;
  /** Null when the person has no membership and no onboarded recruitment outcome. */
  memberSince: { label: string; source: "MEMBERSHIP" | "RECRUITMENT" } | null;
  /** Ascending by term start. */
  terms: ServiceTermRow[];
  capabilities: {
    /** Verified language codes. Optional so credentials issued before languages
     *  were generalized still parse; absent reads the same as none. */
    verifiedLanguages?: string[];
    licensedRN: boolean;
  };
  /** Upgrades to "ATTENDED" only if attendance capture is ever built. */
  basis: "SCHEDULED";
  generatedAt: string;
};

/**
 * A term and department with no shift records must never read as a zero. "Not
 * recorded" says the clinic was not counting; "0 scheduled" says the member
 * held no shifts.
 * Collapsing the two would understate a long-serving member on a document that
 * goes to residency programs.
 *
 * Lives here, next to ServiceTermRow, rather than in the PDF renderer: the
 * certificate PDF and the public credential page both format this value and
 * must never disagree about how it reads, and importing it from the PDF
 * module would pull @react-pdf/renderer (no sideEffects: false) into the
 * public page's server bundle for a two-line string helper.
 */
export function formatShifts(shifts: number | null): string {
  return shifts === null ? "Not recorded" : `${shifts} scheduled`;
}

/** Human label for a term row's track. Same reuse rationale as formatShifts above. */
export function trackLabel(track: ServiceTermRow["track"]): string {
  return track === "DIRECTOR" ? "Director" : "Volunteer";
}

/**
 * Hours for a term row, or "Not recorded".
 *
 * Undefined and null read identically on purpose: undefined is an already-issued
 * credential snapshot from before hours existed, null is a department with no
 * hours configured, and neither is a claim about how long the member served.
 *
 * Whole numbers print without a decimal ("18 hours"), halves keep one ("16.5
 * hours"), because a shift length of 5.5 is realistic and 5.50 reads oddly.
 */
export function formatHours(hours: number | null | undefined): string {
  if (hours === null || hours === undefined) return "Not recorded";
  const rounded = Math.round(hours * 100) / 100;
  return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(1)} hours`;
}

/**
 * Clinic dates served, compactly: "May 30, Jun 6, Jun 13".
 *
 * Returns "" for unknown (undefined snapshot or null) and for empty, because
 * this renders as an optional sub-line that is simply omitted rather than a
 * cell needing a placeholder. The shifts cell beside it already distinguishes
 * "not recorded" from "0 scheduled", so repeating that here would be noise.
 *
 * Month and day only: the term name carries the year, and 18 four-digit years
 * in one line is unreadable. Parsed as UTC, matching the noon-UTC calendar
 * markers these keys come from; a local parse would shift every date back a day
 * in US zones.
 */
export function formatServiceDates(dates: string[] | null | undefined): string {
  if (!dates || dates.length === 0) return "";
  return dates
    .map((k) =>
      new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric" }).format(
        new Date(`${k}T12:00:00Z`),
      ),
    )
    .join(", ");
}

/**
 * The shifts cell, with hours appended when both are known: "14 scheduled, 84
 * hours". Falls back to formatShifts alone when hours are not recorded, so a
 * department with no configured shift length reads exactly as it did before.
 */
export function formatShiftsAndHours(
  shifts: number | null,
  hours: number | null | undefined,
): string {
  const base = formatShifts(shifts);
  if (hours === null || hours === undefined) return base;
  return `${base}, ${formatHours(hours)}`;
}
