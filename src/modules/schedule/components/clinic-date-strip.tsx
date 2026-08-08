/**
 * Month-grouped clinic date navigation.
 *
 * Shared by Full Schedule and the Builder, which previously carried identical
 * copy-pasted markup. Grouping by month replaces a single undifferentiated wrap
 * of 15 to 20 pills, which is hard to scan across a whole term.
 *
 * Server component: no "use client" directive.
 */

import Link from "next/link";
import { isoDateKey, formatCalendarDate } from "@/platform/dates";
import { displayDate } from "@/modules/schedule/engine/display";

export type ClinicDateStripProps = {
  dates: Date[];
  /** ISO date key of the currently selected date, or null when none is. */
  selectedKey: string | null;
  hrefFor: (key: string) => string;
  /**
   * Accessible name for the nav landmark. A prop, not a constant: the two call
   * sites describe different things ("Schedule dates" vs "Clinic dates") and
   * both labels are accurate to their page.
   */
  ariaLabel: string;
};

type MonthGroup = { key: string; month: string; dates: Date[] };

/**
 * Group dates into runs of the same month. `dates` is NOT trusted to arrive
 * sorted: `Term.clinicDates` is a raw Postgres array column with no ordering
 * guarantee, and callers have been seen to append a date (e.g. today's,
 * inserted by the check-in feature) to the end rather than in chronological
 * position. Grouping that directly would split one month across two
 * non-contiguous runs and render out of order, so this sorts a *copy*
 * ascending first -- never the caller's own array -- before forming runs.
 * Each group is also keyed on its first date's ISO key rather than the month
 * label, so that even if two runs ever did land on the same month (a bug
 * elsewhere, a future caller, ...), React would still see distinct keys
 * instead of reporting a collision.
 */
function groupByMonth(dates: Date[]): MonthGroup[] {
  const sorted = [...dates].sort((a, b) => a.getTime() - b.getTime());
  const groups: MonthGroup[] = [];
  for (const date of sorted) {
    const month = formatCalendarDate(date, { month: "long", year: "numeric" });
    const last = groups[groups.length - 1];
    if (last && last.month === month) last.dates.push(date);
    else groups.push({ key: isoDateKey(date), month, dates: [date] });
  }
  return groups;
}

export function ClinicDateStrip({ dates, selectedKey, hrefFor, ariaLabel }: ClinicDateStripProps) {
  if (dates.length === 0) return null;

  return (
    <nav aria-label={ariaLabel} className="flex flex-col gap-3">
      {groupByMonth(dates).map((group) => (
        <div key={group.key} className="flex flex-wrap items-center gap-2">
          {/*
            A span, not a SectionHeader: these label a run of links inside a nav
            landmark rather than opening a document section, and promoting them
            to headings would put month names into the page outline.
          */}
          <span className="text-xs font-semibold uppercase tracking-wider text-subtle-foreground">
            {group.month}
          </span>
          {group.dates.map((date) => {
            const key = isoDateKey(date);
            const isSelected = key === selectedKey;
            return (
              <Link
                key={key}
                href={hrefFor(key)}
                aria-current={isSelected ? "page" : undefined}
                className={
                  isSelected
                    ? "inline-flex items-center justify-center min-h-11 rounded-full px-3 py-1 text-sm font-medium bg-brand text-white"
                    : "inline-flex items-center justify-center min-h-11 rounded-full px-3 py-1 text-sm font-medium bg-muted text-foreground-soft hover:bg-muted-strong transition-colors"
                }
              >
                {displayDate(key)}
              </Link>
            );
          })}
        </div>
      ))}
    </nav>
  );
}
