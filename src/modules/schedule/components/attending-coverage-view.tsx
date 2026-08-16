/**
 * The whole clinic's attending coverage, read only.
 *
 * A date x column table -- the shape of the paper master sheet, and the shape a
 * reader wants when the question is "who is covering what on the 20th". The
 * builder is a person x date matrix instead, because building a schedule and
 * reading one are different jobs: this view has no controls at all, so nobody
 * running a clinic day can change the schedule by misclicking while looking
 * something up.
 *
 * Each column header names the department it covers, which is what turns a
 * doctor's name into an answer for a volunteer asking about THEIR team.
 *
 * Server component: no "use client" directive.
 */

import { Badge } from "@/platform/ui/badge";
import { displayDate } from "@/modules/schedule/engine/display";
import type {
  AttendingScheduleRow,
  ClinicSlotView,
  SpecialtyView,
} from "@/modules/schedule/services/attendings";

type Props = {
  rows: AttendingScheduleRow[];
  slots: ClinicSlotView[];
  specialties: SpecialtyView[];
  /** Clinic date to highlight as the "current week" wayfinding cue. */
  highlightDateKey: string | null;
};

export function AttendingCoverageView({ rows, slots, specialties, highlightDateKey }: Props) {
  const specialtyById = new Map(specialties.map((s) => [s.id, s]));

  return (
    <div className="overflow-x-auto rounded-2xl border border-border">
      <table className="w-full border-collapse text-sm" aria-label="Attending coverage">
        <thead>
          <tr className="bg-muted">
            <th
              scope="col"
              className="sticky left-0 z-10 bg-muted border border-border px-3 py-2 text-left text-xs font-medium text-muted-foreground whitespace-nowrap min-w-[130px]"
            >
              Date
            </th>
            {slots.map((s) => (
              <th
                key={s.id}
                scope="col"
                className="border border-border px-3 py-2 text-left text-xs font-medium text-muted-foreground whitespace-nowrap min-w-[130px]"
              >
                {s.label}
                <span className="block font-normal text-subtle-foreground">
                  {s.startTime}-{s.endTime}
                  {s.department ? ` · ${s.department.code}` : ""}
                </span>
              </th>
            ))}
            <th
              scope="col"
              className="border border-border px-3 py-2 text-left text-xs font-medium text-muted-foreground whitespace-nowrap min-w-[130px]"
            >
              On call
              <span className="block font-normal text-subtle-foreground">next week</span>
            </th>
            <th
              scope="col"
              className="border border-border px-3 py-2 text-left text-xs font-medium text-muted-foreground whitespace-nowrap min-w-[120px]"
            >
              Specialty clinic
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const isHighlight = row.dateKey === highlightDateKey;
            const rowBg = isHighlight ? "bg-brand-faint" : row.isClosed ? "bg-muted" : "";
            return (
              <tr key={row.dateKey} className={rowBg}>
                <th
                  scope="row"
                  className={`sticky left-0 z-10 border border-border px-3 py-2 text-left font-normal whitespace-nowrap ${
                    isHighlight ? "bg-brand-faint" : row.isClosed ? "bg-muted" : "bg-surface"
                  }`}
                >
                  <span className="text-xs font-medium text-foreground tabular-nums">
                    {displayDate(row.dateKey)}
                  </span>
                  {row.isClosed && (
                    <span className="ml-1.5 align-middle">
                      <Badge tone="default">
                        {/* Two different facts, kept distinct: the term does not
                            run clinic that day, versus the clinic chose to
                            close a scheduled one. */}
                        {row.isClinicDate ? "Closed" : "No clinic"}
                      </Badge>
                    </span>
                  )}
                </th>

                {slots.map((s) => {
                  const cov = row.slots.find((c) => c.slotId === s.id);
                  // Deactivated attendings are omitted: naming someone who no
                  // longer covers would read as a staffed column.
                  const staffed = row.isClosed ? [] : (cov?.attendings ?? []).filter((a) => a.isActive);
                  return (
                    <td key={s.id} className="border border-border px-3 py-2 align-top">
                      {staffed.length === 0 ? (
                        <span className="text-subtle-foreground">&mdash;</span>
                      ) : (
                        staffed.map((a) => (
                          <span key={a.id} className="block text-foreground">
                            {a.scheduleName}
                          </span>
                        ))
                      )}
                    </td>
                  );
                })}

                <td className="border border-border px-3 py-2 align-top">
                  {/* Shown on closed dates too: on call covers the week leading
                      up to the next clinic day, so someone holds the pager
                      through a break week. */}
                  {row.onCallName ?? <span className="text-subtle-foreground">&mdash;</span>}
                </td>

                <td className="border border-border px-3 py-2 align-top text-muted-foreground">
                  {!row.isClosed && row.specialtyId
                    ? (specialtyById.get(row.specialtyId)?.name ?? <span className="text-subtle-foreground">&mdash;</span>)
                    : <span className="text-subtle-foreground">&mdash;</span>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
