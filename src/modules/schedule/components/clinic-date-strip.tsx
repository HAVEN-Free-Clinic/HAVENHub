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

type MonthGroup = { month: string; dates: Date[] };

/**
 * Group an already-ordered date list into runs of the same month. Runs, not a
 * keyed map, so the caller's ordering is preserved exactly and a term spanning
 * a year boundary cannot collapse two Januaries onto one heading.
 */
function groupByMonth(dates: Date[]): MonthGroup[] {
  const groups: MonthGroup[] = [];
  for (const date of dates) {
    const month = formatCalendarDate(date, { month: "long", year: "numeric" });
    const last = groups[groups.length - 1];
    if (last && last.month === month) last.dates.push(date);
    else groups.push({ month, dates: [date] });
  }
  return groups;
}

export function ClinicDateStrip({ dates, selectedKey, hrefFor, ariaLabel }: ClinicDateStripProps) {
  if (dates.length === 0) return null;

  return (
    <nav aria-label={ariaLabel} className="flex flex-col gap-3">
      {groupByMonth(dates).map((group) => (
        <div key={group.month} className="flex flex-wrap items-center gap-2">
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
