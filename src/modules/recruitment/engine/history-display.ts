import type { HistoricalOutcome, Track } from "@prisma/client";
import type { ApplicantHistory, HistoryEntry } from "../services/history";
import { stageLabel } from "@/platform/airtable/import/history/stages";

/**
 * The words a recruitment history renders in, shared by its two renderers: the
 * server card (components/applicant-history.tsx) and the speed-score modal. The
 * modal is a client component, so it cannot render the card's server-only dates
 * and gets this same text pre-built on its view instead. Keeping the rules here
 * is what stops the two from describing one past application two ways.
 */

export const TRACK_LABEL: Record<Track, string> = { VOLUNTEER: "Volunteer", DIRECTOR: "Director" };

export const OUTCOME_LABEL: Record<HistoricalOutcome, string> = {
  ACCEPTED: "Accepted",
  REJECTED: "Rejected",
  WAITLISTED: "Waitlisted",
  WITHDRAWN: "Withdrawn",
  INELIGIBLE: "Ineligible",
  NO_DECISION: "No recorded outcome",
  UNKNOWN: "Unknown",
};

/** Month + year only ("Sep 2024"); archived interest-form rows carry no time worth showing. */
export const MONTH_YEAR = { year: "numeric", month: "short" } as const;

function ordinal(n: number): string {
  const suffix: Record<Intl.LDMLPluralRule, string> = { one: "st", two: "nd", few: "rd", other: "th", zero: "th", many: "th" };
  return `${n}${suffix[new Intl.PluralRules("en-US", { type: "ordinal" }).select(n)]}`;
}

/**
 * Reads the summary straight off the service's own tallies (applicationCount,
 * furthest) instead of recomputing them, so this line can never drift from
 * getApplicantHistory's counting rules, most importantly that interest-form
 * entries are never counted as applications.
 *
 * `pendingApplication` must be true only where the application under review is
 * on screen (its detail card and the speed scorer): those callers query with
 * `excludeApplicationId`, so that application is deliberately missing from
 * `history` and the ordinal below adds it back. Every other mount (the admin
 * person profile, the history browser) queries with no exclusion, so `history`
 * already counts every application and must not claim one more than it has.
 * This is an explicit parameter rather than an inference from `entries` or
 * `applicationCount`, because a silent inference over that same shape is what
 * produced the wrong ordinal on those other mounts in the first place.
 */
export function summaryLine(history: ApplicantHistory, pendingApplication: boolean): string {
  if (history.entries.length === 0) {
    return pendingApplication ? "First application, no earlier record." : "No recorded applications.";
  }
  if (history.applicationCount === 0) return "First application. Interest form on file.";
  const { furthest } = history;
  const count = history.applicationCount + (pendingApplication ? 1 : 0);
  const countLabel = pendingApplication
    ? `${ordinal(count)} application`
    : `${count} prior application${count === 1 ? "" : "s"}`;
  if (!furthest) return `${countLabel}.`;
  // `furthest` carries a stage and cycle label but no track of its own (see
  // ApplicantHistory in history.ts), and stageLabel needs one. Look up the
  // application entry that produced it to read the track off directly, rather
  // than recomputing which entry is furthest: history.entries preserves the
  // same order getApplicantHistory scanned, so the first application entry
  // matching both the stage and the cycle label is the same entry the service
  // picked as its "best".
  const source = history.entries.find(
    (e) => e.kind === "application" && e.furthestStage === furthest.stage && e.cycleLabel === furthest.cycleLabel,
  );
  const label = stageLabel(furthest.stage, source?.track ?? "VOLUNTEER");
  return `${countLabel}. Furthest: ${label} (${furthest.cycleLabel}).`;
}

/** Track and departments under an application row. The placement is shown
 *  distinctly from the choices it was drawn from (or without them, if none
 *  survived mapping) so a routed-then-accepted department is never confused
 *  with the departments merely applied to. */
export function applicationMeta(entry: HistoryEntry): string {
  const departments = [
    entry.departmentCodes.join(", ") || null,
    entry.resultDepartment ? `-> ${entry.resultDepartment}` : null,
  ]
    .filter(Boolean)
    .join(" ");
  return [TRACK_LABEL[entry.track], departments || null].filter(Boolean).join(" · ");
}

/** Stage and outcome badge on an application row. Application entries always
 *  carry both; the fallbacks are defensive, so a malformed row still renders. */
export function applicationBadge(entry: HistoryEntry): string {
  const stage = entry.furthestStage ?? "APPLIED";
  const outcome = entry.outcome ?? "NO_DECISION";
  return `${stageLabel(stage, entry.track)} - ${OUTCOME_LABEL[outcome]}`;
}

export type HistoryRowView = {
  key: string;
  title: string;
  href: string | null;
  meta: string | null;
  badge: string;
};

/** Every history row as plain text, for a renderer that cannot format dates
 *  itself. `monthYear` formats an interest form's date in the display zone. */
export function historyRowViews(history: ApplicantHistory, monthYear: (d: Date | null) => string): HistoryRowView[] {
  return history.entries.map((entry, i) => {
    const key = `${entry.era}-${entry.kind}-${entry.cycleCode}-${i}`;
    // Interest entries carry no track, departments, stage, or outcome: a date
    // and "Interest form" is what keeps them from reading as a failed application.
    if (entry.kind === "interest") {
      return { key, title: monthYear(entry.occurredAt), href: null, meta: null, badge: "Interest form" };
    }
    return { key, title: entry.cycleLabel, href: entry.href, meta: applicationMeta(entry), badge: applicationBadge(entry) };
  });
}
