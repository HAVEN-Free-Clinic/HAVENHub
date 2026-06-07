/**
 * ClinicDatesEditor: server component for managing a term's clinic dates.
 *
 * Three operations, each posting to the provided action:
 *  - Remove a single date (posts remaining dates to updateClinicDates)
 *  - Add a date (appends new date to current list)
 *  - Regenerate Saturdays (replaces with saturdaysBetween(startDate, endDate))
 *
 * All mutations route through a single server action that calls updateClinicDates.
 * Dates are rendered in UTC per convention.
 */

import type { ReactNode } from "react";
import { Input } from "@/platform/ui/input";
import { Button } from "@/platform/ui/button";
import { ConfirmButton } from "@/platform/ui/confirm-button";

function formatClinicDate(d: Date): string {
  return d.toLocaleDateString("en-US", {
    timeZone: "UTC",
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function toIsoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

type ClinicDatesEditorProps = {
  termId: string;
  clinicDates: Date[];
  /** ISO date strings for all Saturdays between startDate and endDate. */
  saturdayIsos: string[];
  /** Server action: receives FormData with "dates" (JSON array) and "termId". */
  updateAction: (formData: FormData) => Promise<void>;
};

function HiddenDatesField({ dates }: { dates: string[] }) {
  // Serialize the date array as JSON in a single hidden field.
  return <input type="hidden" name="dates" value={JSON.stringify(dates)} />;
}

export function ClinicDatesEditor({
  termId,
  clinicDates,
  saturdayIsos,
  updateAction,
}: ClinicDatesEditorProps): ReactNode {
  const currentIsos = clinicDates.map(toIsoDate);

  return (
    <div className="space-y-4">
      {/* List of dates with per-date remove buttons */}
      <div className="space-y-1">
        {clinicDates.length === 0 && (
          <p className="text-sm text-slate-400">No clinic dates set.</p>
        )}
        {clinicDates.map((d, idx) => {
          // Remaining dates after removing this one.
          const remaining = currentIsos.filter((_, i) => i !== idx);
          return (
            <div key={toIsoDate(d)} className="flex items-center gap-3">
              <span className="w-52 text-sm">{formatClinicDate(d)}</span>
              <form action={updateAction}>
                <input type="hidden" name="termId" value={termId} />
                <HiddenDatesField dates={remaining} />
                <ConfirmButton
                  label="Remove"
                  confirmLabel="Confirm remove?"
                />
              </form>
            </div>
          );
        })}
      </div>

      {/* Add a single date */}
      <form action={updateAction} className="flex items-end gap-3">
        <input type="hidden" name="termId" value={termId} />
        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium text-slate-500">Add date</label>
          <Input type="date" name="addDate" className="w-44" />
        </div>
        <Button type="submit" variant="outline" size="sm">
          Add
        </Button>
      </form>

      {/* Regenerate Saturdays */}
      <form action={updateAction}>
        <input type="hidden" name="termId" value={termId} />
        <HiddenDatesField dates={saturdayIsos} />
        <input type="hidden" name="regenerate" value="1" />
        <div className="flex items-center gap-3">
          <ConfirmButton
            label="Regenerate Saturdays"
            confirmLabel={`Replace with ${saturdayIsos.length} Saturday(s)?`}
          />
          <span className="text-xs text-slate-400">
            Replaces all dates with the {saturdayIsos.length} Saturday(s) between the term start and end.
          </span>
        </div>
      </form>
    </div>
  );
}
