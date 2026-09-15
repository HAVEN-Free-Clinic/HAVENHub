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
import { ScrollFade } from "@/platform/ui/scroll-fade";
import { isoDateKey } from "@/platform/dates";
import { displayDate } from "@/modules/schedule/engine/display";
import { groupByMonth } from "./clinic-date-order";
import { SelectedIntoView } from "./selected-into-view";

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
  const anyClosed = dates.some((d) => closed.has(isoDateKey(d)));

  // One run of months, not one row per month. Stacked a row per month, a
  // five-month term pushed the Builder's schedule ~717px down the page, and on a
  // phone each month wrapped again, so Full schedule opened on a wall of pills.
  // On a phone it is a single scrolling row (SelectedIntoView keeps the chosen
  // date on screen, ScrollFade says there is more); from sm up the months flow
  // and wrap together, usually into two or three lines.
  return (
    <div className="space-y-2">
    <SelectedIntoView selectedKey={selectedKey}>
    <ScrollFade>
    <nav
      aria-label={ariaLabel}
      className="flex gap-x-5 gap-y-2 overflow-x-auto [scrollbar-width:none] sm:flex-wrap sm:overflow-visible [&::-webkit-scrollbar]:hidden"
    >
      {groupByMonth(dates).map((group) => (
        <div key={group.key} className="flex shrink-0 items-center gap-2 sm:shrink sm:flex-wrap">
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
                  "inline-flex shrink-0 items-center justify-center whitespace-nowrap min-h-11 rounded-full px-3 py-1 text-sm font-medium transition-colors",
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
    </ScrollFade>
    </SelectedIntoView>
    {/* The dashed ring had no key on screen: sighted users met an orange outline
        with nothing saying what it meant. Shown only when a closed date is in
        the strip, and the swatch is decorative; each pill already announces
        its own closure to a screen reader. */}
    {anyClosed && (
      <p className="flex items-center gap-2 text-xs text-subtle-foreground">
        <span aria-hidden className="inline-block h-4 w-7 shrink-0 rounded-full border border-dashed border-warning" />
        Dashed outline: the clinic is closed that date. It can still be scheduled.
      </p>
    )}
    </div>
  );
}
