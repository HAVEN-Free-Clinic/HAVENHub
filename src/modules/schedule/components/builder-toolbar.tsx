/**
 * Builder toolbar: department, working term, and the view selector.
 *
 * The Builder has one department, one term, and the user is doing exactly one
 * of three jobs. That single choice used to be spread across two independent
 * URL params (`view` and `mode`) with nothing on screen saying so. This control
 * presents it as one selector while emitting the params unchanged, so every
 * existing bookmark and emailed deep link still resolves.
 *
 * Server component: no "use client" directive.
 */

import Link from "next/link";
import { Button } from "@/platform/ui/button";
import { Select } from "@/platform/ui/select";
import { NavForm } from "@/platform/ui/nav-form";
import { TermSwitcher } from "@/platform/ui/term-switcher";
import type { TermOption } from "@/platform/terms/term-options";
import { cx } from "@/platform/ui/cx";

export type BuilderView = "day" | "grid" | "availability";

export type BuilderHrefParams = {
  dept?: string | null;
  date?: string | null;
  term?: string | null;
  gmode?: string | null;
};

/**
 * Map the raw query params onto the single view the user is in.
 *
 * `mode=availability` wins over `view` because that is how the page behaves
 * today (the availability editor renders "over either view"), and changing it
 * would silently redirect existing links.
 */
export function resolveBuilderView(view: string | undefined, mode: string | undefined): BuilderView {
  if (mode === "availability") return "availability";
  if (view === "grid") return "grid";
  return "day";
}

/** Build a href that selects `view` while preserving department, date, and term. */
export function builderViewHref(base: string, p: BuilderHrefParams, view: BuilderView): string {
  const params = new URLSearchParams();
  if (p.dept) params.set("dept", p.dept);
  if (p.date) params.set("date", p.date);
  if (view === "grid") params.set("view", "grid");
  if (view === "availability") params.set("mode", "availability");
  // gmode only means anything inside Grid; dropping it elsewhere keeps a stale
  // shadow mode from riding along into a view that ignores it.
  if (view === "grid" && p.gmode) params.set("gmode", p.gmode);
  if (p.term) params.set("term", p.term);
  const qs = params.toString();
  return qs ? `${base}?${qs}` : base;
}

const VIEW_LABELS: Array<{ value: BuilderView; label: string }> = [
  { value: "day", label: "Day" },
  { value: "grid", label: "Grid" },
  { value: "availability", label: "Availability" },
];

export type BuilderToolbarProps = {
  departments: Array<{ id: string; code: string; name: string }>;
  selectedDeptId: string;
  hrefParams: BuilderHrefParams;
  view: BuilderView;
  termOptions: TermOption[];
  workingTermId: string;
  liveTermId: string | null;
  hrefForTerm: (termId: string | null) => string;
};

export function BuilderToolbar({
  departments,
  selectedDeptId,
  hrefParams,
  view,
  termOptions,
  workingTermId,
  liveTermId,
  hrefForTerm,
}: BuilderToolbarProps) {
  return (
    <div className="mb-6 flex flex-wrap items-end gap-x-6 gap-y-4 rounded-2xl border border-border bg-muted px-4 py-3">
      <div className="flex flex-col gap-1.5">
        <span className="text-xs font-semibold uppercase tracking-wider text-subtle-foreground">Department</span>
        <NavForm action="/schedule/builder" className="flex items-center gap-2">
          {hrefParams.date && <input type="hidden" name="date" value={hrefParams.date} />}
          {view === "grid" && <input type="hidden" name="view" value="grid" />}
          {view === "availability" && <input type="hidden" name="mode" value="availability" />}
          {view === "grid" && hrefParams.gmode && <input type="hidden" name="gmode" value={hrefParams.gmode} />}
          {hrefParams.term && <input type="hidden" name="term" value={hrefParams.term} />}
          <Select name="dept" aria-label="Department" defaultValue={selectedDeptId}>
            {departments.map((d) => (
              <option key={d.id} value={d.id}>{d.code} - {d.name}</option>
            ))}
          </Select>
          <Button type="submit" variant="outline" size="sm">Go</Button>
        </NavForm>
      </div>

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
        <div className="inline-flex overflow-hidden rounded-lg border border-border bg-surface">
          {VIEW_LABELS.map(({ value, label }) => (
            <Link
              key={value}
              href={builderViewHref("/schedule/builder", hrefParams, value)}
              aria-current={view === value ? "page" : undefined}
              className={cx(
                "inline-flex items-center min-h-11 px-3 py-1.5 text-sm font-medium transition-colors border-l border-border first:border-l-0",
                view === value ? "bg-brand text-white" : "text-muted-foreground hover:text-foreground-soft",
              )}
            >
              {label}
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}
