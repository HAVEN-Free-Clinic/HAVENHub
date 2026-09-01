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
import { cx } from "@/platform/ui/cx";
import { isoDateKey } from "@/platform/dates";
import { displayDate } from "@/modules/schedule/engine/display";
import { groupByMonth } from "./clinic-date-order";

export type ClinicDateStripProps = {
  dates: Date[];
  /** ISO date key of the currently selected date, or null when none is. */
  selectedKey: string | null;
  /**
   * Date keys the clinic has declared closed. Marked, never removed: a closed
   * Saturday is still assignable (departments run triage on one), so dropping
   * the pill would take away the only way to reach the date it labels.
   */
  closedKeys?: readonly string[];
  hrefFor: (key: string) => string;
  /**
   * Accessible name for the nav landmark. A prop, not a constant: the two call
   * sites describe different things ("Schedule dates" vs "Clinic dates") and
   * both labels are accurate to their page.
   */
  ariaLabel: string;
};

export function ClinicDateStrip({ dates, selectedKey, closedKeys, hrefFor, ariaLabel }: ClinicDateStripProps) {
  if (dates.length === 0) return null;

  const closed = new Set(closedKeys ?? []);

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
            const isClosed = closed.has(key);
            return (
              <Link
                key={key}
                href={hrefFor(key)}
                aria-current={isSelected ? "page" : undefined}
                className={cx(
                  "inline-flex items-center justify-center min-h-11 rounded-full px-3 py-1 text-sm font-medium transition-colors",
                  isSelected
                    ? "bg-brand text-white"
                    : "bg-muted text-foreground-soft hover:bg-muted-strong",
                  // A dashed ring rather than a dimmed pill: dimming would read
                  // as "disabled", and these dates are still fully editable. The
                  // ring is the whole signal -- there used to be an amber dot
                  // inside the pill saying the same thing a second time, which
                  // read as decoration (same tell as the old Badge status dot).
                  isClosed && "border border-dashed border-warning",
                )}
              >
                {displayDate(key)}
                {/* The ring carries no meaning to a screen reader, and the pill's
                    own text is just a date, so the state is spelled out here. */}
                {isClosed && <span className="sr-only"> (clinic closed)</span>}
              </Link>
            );
          })}
        </div>
      ))}
    </nav>
  );
}
