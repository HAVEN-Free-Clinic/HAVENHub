import type { ApplicantHistory as ApplicantHistoryData, HistoryEntry } from "@/modules/recruitment/services/history";
import { MONTH_YEAR, applicationBadge, applicationMeta, summaryLine } from "@/modules/recruitment/engine/history-display";
import { Card } from "@/platform/ui/card";
import { TextLink } from "@/platform/ui/text-link";
import { SectionHeader } from "@/platform/ui/section-header";
import { Badge } from "@/platform/ui/badge";
import { DateTime } from "@/platform/dates/display";

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

  return (
    <li className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-5 py-3">
      <div className="min-w-0">
        {entry.href ? (
          <TextLink href={entry.href} size="sm" className="font-medium">
            {entry.cycleLabel}
          </TextLink>
        ) : (
          <span className="text-sm font-medium text-foreground">{entry.cycleLabel}</span>
        )}
        <p className="mt-0.5 text-xs text-subtle-foreground">{applicationMeta(entry)}</p>
      </div>
      <Badge className="shrink-0">{applicationBadge(entry)}</Badge>
    </li>
  );
}

/**
 * History card shared by three mounts: the reviewer's application detail
 * page, the admin person profile, and the history browser's detail page. (The
 * speed-score modal shows the same record, built from the same wording in
 * engine/history-display.ts, since a client component cannot render this.) A
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
 * summaryLine's doc comment (engine/history-display.ts) for why.
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
