import { Card } from "@/platform/ui/card";
import { EmptyState } from "@/platform/ui/empty-state";
import type { QuestionSummary } from "@/modules/forms/service";

/** A horizontal bar: share of answers, labelled with the count and percent. */
function Bar({ label, count, total }: { label: string; count: number; total: number }) {
  const pct = total > 0 ? Math.round((count / total) * 100) : 0;
  return (
    <div className="grid grid-cols-[minmax(0,12rem)_1fr_auto] items-center gap-3 text-sm">
      <span className="truncate text-foreground-soft" title={label}>
        {label}
      </span>
      <span className="h-2.5 overflow-hidden rounded-full bg-muted" aria-hidden="true">
        <span className="block h-full rounded-full bg-brand" style={{ width: `${pct}%` }} />
      </span>
      <span className="w-20 text-right tabular-nums text-muted-foreground">
        {count} ({pct}%)
      </span>
    </div>
  );
}

/**
 * Per-question results. Choice questions show each option's share of the
 * people who answered (a checkbox question's shares can sum past 100%);
 * ratings show the average and the spread; text shows every answer.
 */
export function ResultsSummary({ summary }: { summary: QuestionSummary[] }) {
  return (
    <div className="space-y-4">
      {summary.map((s) => (
        <Card key={s.key} className="space-y-3">
          <div>
            <p className="text-sm font-semibold text-foreground">{s.label}</p>
            <p className="text-xs text-muted-foreground">
              {s.answered} {s.answered === 1 ? "answer" : "answers"}
              {s.kind === "rating" && s.average !== null && ` · average ${s.average.toFixed(1)} of ${s.max}`}
            </p>
          </div>
          {s.kind === "choice" && (
            <div className="space-y-1.5">
              {s.counts.map((c) => (
                <Bar key={c.option} label={c.option} count={c.count} total={s.answered} />
              ))}
            </div>
          )}
          {s.kind === "rating" && (
            <div className="space-y-1.5">
              {s.counts.map((count, i) => (
                <Bar key={i} label={String(i + 1)} count={count} total={s.answered} />
              ))}
            </div>
          )}
          {s.kind === "text" &&
            (s.answers.length === 0 ? (
              <EmptyState inline>No answers.</EmptyState>
            ) : (
              <ul className="max-h-96 space-y-2 overflow-y-auto pr-1">
                {s.answers.map((a, i) => (
                  <li key={i} className="rounded-lg bg-muted px-3 py-2 text-sm">
                    <p className="whitespace-pre-line text-foreground">{a.text}</p>
                    <p className="mt-1 text-xs text-muted-foreground">{a.name}</p>
                  </li>
                ))}
              </ul>
            ))}
        </Card>
      ))}
    </div>
  );
}
