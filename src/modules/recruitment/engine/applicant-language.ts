/**
 * The applicant roster's Language column, and the filter that finds the rows
 * still owed a verdict.
 *
 * The interpreting department assesses some applicants BEFORE a decision (see
 * Department.assessLanguageBeforeAcceptance and platform/languages), and until
 * now the only place that verdict appeared was the applicant detail page, one
 * applicant at a time. A department deciding a cycle reads the roster, not
 * forty detail pages, so the verdict has to be on the row it is deciding.
 *
 * ADVISORY, exactly as it is on the detail page: nothing here gates, disables,
 * or is a precondition for any decision control. It is what the department
 * reads before making its own call.
 *
 * Pure: the caller resolves the verdicts (services/applicant-language.ts) and
 * hands them in, so this module stays free of Prisma and testable with plain
 * object literals, like its sibling roster engines.
 */

/** One language's standing verdict, reduced to what a roster cell renders. */
export type RosterLanguageVerdict = {
  /** Lowercase code, matching PersonLanguage.language. */
  language: string;
  /**
   * Tri-state, carried through from LanguageVerdict.verified: null means a
   * human's involvement is on file with no recorded yes/no outcome. It must
   * never render as a verdict nobody actually recorded, so the cell keeps the
   * three states apart rather than coercing to a boolean.
   */
  verified: boolean | null;
  score: number | null;
};

/**
 * What the Language column knows about one application: every language it is
 * assessed on, each with the verdict that stands or null while none does.
 *
 * An empty `entries` means this application is assessed on nothing, which is
 * the common case outside the lane departments and reads as "-" rather than as
 * "awaiting".
 */
export type RosterLanguageStatus = {
  entries: { language: string; verdict: RosterLanguageVerdict | null }[];
};

export const EMPTY_LANGUAGE_STATUS: RosterLanguageStatus = { entries: [] };

/**
 * Still owed at least one verdict.
 *
 * This is the question the department is actually asking on the roster: it is
 * why the column exists. An application assessed on nothing is NOT awaiting,
 * so a cycle outside the lane never reads as one long queue of missing work.
 */
export function isAwaitingLanguageAssessment(status: RosterLanguageStatus): boolean {
  return status.entries.some((e) => e.verdict === null);
}

/** Every language on this row has a verdict, and there was at least one to have. */
export function isLanguageAssessed(status: RosterLanguageStatus): boolean {
  return status.entries.length > 0 && status.entries.every((e) => e.verdict !== null);
}

/**
 * The score the column sorts on: the highest recorded across this row's
 * languages, or null when none carries one.
 *
 * Highest rather than first, because the roster cell can hold more than one
 * language and the reason to sort the column is "who speaks this best". A
 * verdict with no score does not count as a zero; see the null handling in
 * sortApplicants, where unscored rows sink in both directions.
 */
export function languageScoreOf(status: RosterLanguageStatus): number | null {
  const scores = status.entries
    .map((e) => e.verdict?.score)
    .filter((s): s is number => typeof s === "number");
  return scores.length > 0 ? Math.max(...scores) : null;
}

export const LANGUAGE_FILTER_VALUES = ["awaiting", "assessed"] as const;
export type LanguageFilterValue = (typeof LANGUAGE_FILTER_VALUES)[number];

/** Reads the roster's `language` query param, or null for no filter, so a
 *  hand-edited URL falls back to the unfiltered roster rather than an empty one. */
export function parseLanguageFilter(raw: string | null | undefined): LanguageFilterValue | null {
  return LANGUAGE_FILTER_VALUES.includes(raw as LanguageFilterValue)
    ? (raw as LanguageFilterValue)
    : null;
}

/**
 * Narrows a roster to rows awaiting a verdict, or to rows that have one.
 *
 * `statusOf` is a lookup rather than a field on the row: the verdicts are
 * resolved for the whole roster in one query and held in a map keyed by
 * application id, so nothing has to be spliced onto the Prisma rows to filter
 * on it.
 */
export function filterApplicantsByLanguage<T>(
  apps: T[],
  statusOf: (app: T) => RosterLanguageStatus,
  filter: LanguageFilterValue | null,
): T[] {
  if (!filter) return apps;
  return apps.filter((a) =>
    filter === "awaiting" ? isAwaitingLanguageAssessment(statusOf(a)) : isLanguageAssessed(statusOf(a)),
  );
}
