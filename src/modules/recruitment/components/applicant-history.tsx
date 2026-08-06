import Link from "next/link";
import type { HistoricalOutcome, Track } from "@prisma/client";
import type { ApplicantHistory as ApplicantHistoryData, HistoryEntry } from "@/modules/recruitment/services/history";
import { stageLabel } from "@/platform/airtable/import/history/stages";
import { Card } from "@/platform/ui/card";
import { SectionHeader } from "@/platform/ui/section-header";
import { Badge } from "@/platform/ui/badge";
import { DateTime } from "@/platform/dates/display";

const TRACK_LABEL: Record<Track, string> = { VOLUNTEER: "Volunteer", DIRECTOR: "Director" };

const OUTCOME_LABEL: Record<HistoricalOutcome, string> = {
  ACCEPTED: "Accepted",
  REJECTED: "Rejected",
  WAITLISTED: "Waitlisted",
  WITHDRAWN: "Withdrawn",
  INELIGIBLE: "Ineligible",
  NO_DECISION: "No recorded outcome",
  UNKNOWN: "Unknown",
};

/** Month + year only ("Sep 2024"); archived interest-form rows carry no time worth showing. */
const MONTH_YEAR = { year: "numeric", month: "short" } as const;

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
 * `pendingApplication` must be true only for the reviewer's application detail
 * card: its caller queries with `excludeApplicationId`, so the application
 * currently under review is deliberately missing from `history` and the
 * ordinal below adds it back. Every other mount (the admin person profile,
 * the history browser) queries with no exclusion, so `history` already counts
 * every application and must not claim one more than it has. This is an
 * explicit parameter rather than an inference from `entries` or
 * `applicationCount`, because a silent inference over that same shape is what
 * produced the wrong ordinal on those other mounts in the first place.
 */
export function summaryLine(history: ApplicantHistoryData, pendingApplication: boolean): string {
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

function HistoryRow({ entry }: { entry: HistoryEntry }) {
  if (entry.kind === "interest") {
    // Interest entries carry no track, department choices, stage, or outcome:
    // rendering only a date and "Interest form" is what keeps them from
    // reading as a (failed) application.
    return (
      <li className="flex items-center justify-between gap-3 px-5 py-3">
        <span className="text-sm text-foreground-soft">
          <DateTime value={entry.occurredAt} opts={MONTH_YEAR} />
        </span>
        <Badge>Interest form</Badge>
      </li>
    );
  }

  // Application entries always carry a stage and outcome; the fallbacks here
  // are defensive rather than expected, so a malformed row still renders
  // instead of crashing the page.
  const stage = entry.furthestStage ?? "APPLIED";
  const outcome = entry.outcome ?? "NO_DECISION";
  // The placement is shown distinctly from the choices it was drawn from
  // (or without them, if none survived mapping) so a routed-then-accepted
  // department is never confused with the departments merely applied to.
  const departments = [
    entry.departmentCodes.join(", ") || null,
    entry.resultDepartment ? `-> ${entry.resultDepartment}` : null,
  ]
    .filter(Boolean)
    .join(" ");
  const meta = [TRACK_LABEL[entry.track], departments || null].filter(Boolean).join(" · ");

  return (
    <li className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-5 py-3">
      <div className="min-w-0">
        {entry.href ? (
          <Link href={entry.href} className="text-sm font-medium text-brand-fg hover:text-brand-hover">
            {entry.cycleLabel}
          </Link>
        ) : (
          <span className="text-sm font-medium text-foreground">{entry.cycleLabel}</span>
        )}
        <p className="mt-0.5 text-xs text-subtle-foreground">{meta}</p>
      </div>
      <Badge className="shrink-0">
        {stageLabel(stage, entry.track)} - {OUTCOME_LABEL[outcome]}
      </Badge>
    </li>
  );
}

/**
 * History card shared by three mounts: the reviewer's application detail
 * page, the admin person profile, and the history browser's detail page. A
 * one-line summary (drawn straight from the service's own applicationCount
 * and furthest tallies) plus one row per prior cycle or interest-form
 * submission, newest first.
 *
 * Renders even when history is empty, showing empty-state copy rather than
 * disappearing. A missing card would be ambiguous between "new applicant" and
 * "something failed to load"; confirming a genuine first-timer is itself
 * useful information to a reviewer.
 *
 * `pendingApplication` must be true ONLY on the reviewer's card -- see
 * summaryLine's doc comment for why.
 */
export function ApplicantHistory({
  history,
  title,
  pendingApplication = false,
}: {
  history: ApplicantHistoryData;
  title: string;
  pendingApplication?: boolean;
}) {
  return (
    <Card pad={false}>
      <div className="px-5 py-4">
        <SectionHeader>{title}</SectionHeader>
        <p className="mt-1 text-sm text-foreground-soft">{summaryLine(history, pendingApplication)}</p>
      </div>
      {history.entries.length > 0 && (
        <ul className="divide-y divide-border-subtle border-t border-border-subtle">
          {history.entries.map((entry, i) => (
            <HistoryRow key={`${entry.era}-${entry.kind}-${entry.cycleCode}-${i}`} entry={entry} />
          ))}
        </ul>
      )}
    </Card>
  );
}
