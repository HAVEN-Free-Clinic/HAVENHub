/**
 * Attendings builder toolbar: working term, view, and what the grid assigns.
 *
 * Mirrors BuilderToolbar so the attending schedule is driven the same way as
 * every department schedule. The one extra control is "Assigning", which names
 * the schedule column a grid click fills -- the attending grid is a person x
 * date matrix, so the column has to come from somewhere, and a per-cell picker
 * would mean a select in every one of several hundred cells.
 *
 * Server component: no "use client" directive.
 */

import Link from "next/link";
import { Select } from "@/platform/ui/select";
import { Button } from "@/platform/ui/button";
import { NavForm } from "@/platform/ui/nav-form";
import { TermSwitcher } from "@/platform/ui/term-switcher";
import type { TermOption } from "@/platform/terms/term-options";
import { cx } from "@/platform/ui/cx";
import type { ClinicSlotView } from "@/modules/schedule/services/attendings";

export type AttendingView = "grid" | "day";

/** The grid's assign target: a schedule column, or the on-call pager. */
export const ON_CALL_TARGET = "oncall";

export type AttendingHrefParams = {
  date?: string | null;
  term?: string | null;
  /** A slot id, or ON_CALL_TARGET. */
  target?: string | null;
};

/** Build a href that selects `view` while preserving date, term, and target. */
export function attendingViewHref(
  base: string,
  p: AttendingHrefParams,
  view: AttendingView,
): string {
  const params = new URLSearchParams();
  if (view === "day") params.set("view", "day");
  if (p.date) params.set("date", p.date);
  // The assign target only means anything inside the grid; dropping it in the
  // Day view keeps a stale on-call mode from riding along into a view that
  // ignores it and then reappearing on the way back.
  if (view === "grid" && p.target) params.set("target", p.target);
  if (p.term) params.set("term", p.term);
  const qs = params.toString();
  return qs ? `${base}?${qs}` : base;
}

const VIEW_LABELS: Array<{ value: AttendingView; label: string }> = [
  { value: "grid", label: "Grid" },
  { value: "day", label: "Day" },
];

export type AttendingToolbarProps = {
  base: string;
  view: AttendingView;
  hrefParams: AttendingHrefParams;
  slots: ClinicSlotView[];
  /** A slot id, or ON_CALL_TARGET. */
  target: string;
  termOptions: TermOption[];
  workingTermId: string;
  liveTermId: string | null;
  hrefForTerm: (termId: string | null) => string;
};

export function AttendingToolbar({
  base,
  view,
  hrefParams,
  slots,
  target,
  termOptions,
  workingTermId,
  liveTermId,
  hrefForTerm,
}: AttendingToolbarProps) {
  return (
    <div className="mb-6 flex flex-wrap items-end gap-x-6 gap-y-4 rounded-2xl border border-border bg-muted px-4 py-3">
      {/*
        No label wrapper here. TermSwitcher already renders its own "Term"
        eyebrow inside a nav[aria-label="Working term"], so adding one would
        print the word twice.
      */}
      <TermSwitcher
        options={termOptions}
        selectedId={workingTermId}
        liveTermId={liveTermId}
        hrefForTerm={hrefForTerm}
      />

      <div className="flex flex-col gap-1.5">
        <span className="text-xs font-semibold uppercase tracking-wider text-subtle-foreground">View</span>
        <nav aria-label="View" className="inline-flex overflow-hidden rounded-lg border border-border bg-surface">
          {VIEW_LABELS.map(({ value, label }) => (
            <Link
              key={value}
              href={attendingViewHref(base, hrefParams, value)}
              aria-current={view === value ? "page" : undefined}
              className={cx(
                "inline-flex items-center min-h-11 px-3 py-1.5 text-sm font-medium transition-colors border-l border-border first:border-l-0",
                view === value ? "bg-brand text-white" : "text-muted-foreground hover:text-foreground-soft",
              )}
            >
              {label}
            </Link>
          ))}
        </nav>
      </div>

      {view === "grid" && (
        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-semibold uppercase tracking-wider text-subtle-foreground">
            Assigning
          </span>
          <NavForm action={base} className="flex items-center gap-2">
            {hrefParams.date && <input type="hidden" name="date" value={hrefParams.date} />}
            {hrefParams.term && <input type="hidden" name="term" value={hrefParams.term} />}
            <Select name="target" aria-label="Schedule column a grid click fills" defaultValue={target}>
              {slots.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                  {s.department ? ` (${s.department.code})` : ""}
                </option>
              ))}
              <option value={ON_CALL_TARGET}>On call (next week)</option>
            </Select>
            <Button type="submit" variant="outline" size="sm">Go</Button>
          </NavForm>
        </div>
      )}
    </div>
  );
}
