/**
 * ClinicDatesEditor: server component for managing a term's clinic dates.
 *
 * Four operations, each posting to the provided action:
 *  - Remove a single date (posts remaining dates to updateClinicDates)
 *  - Add a date (appends new date to current list)
 *  - Regenerate Saturdays (replaces with saturdaysBetween(startDate, endDate))
 *  - Set or clear a date's closure, with an optional reason (posts to closureAction)
 *
 * Closure is owned by admin.manage_terms, the same grant as the dates
 * themselves. It is stored on ClinicDay rather than on Term, so the page reads
 * those rows and passes them in as `closures`.
 *
 * All mutations route through a single server action that calls updateClinicDates.
 * Dates are rendered in UTC per convention.
 */

import type { ReactNode } from "react";
import { Input, Field } from "@/platform/ui/input";
import { Button } from "@/platform/ui/button";
import { Checkbox } from "@/platform/ui/checkbox";
import { ConfirmButton } from "@/platform/ui/confirm-button";
import { formatCalendarDate } from "@/platform/dates";
import { EmptyState } from "@/platform/ui/empty-state";

function formatClinicDate(d: Date): string {
  return formatCalendarDate(d, {
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
  /** Closure by ISO date key. A missing entry means the date is open. */
  closures: Record<string, { isClosed: boolean; closedNote: string | null }>;
  /** Server action: receives "dateKey", "isClosed" and "closedNote". */
  closureAction: (formData: FormData) => Promise<void>;
  /**
   * False when the term is ARCHIVED. setClinicDayClosure calls loadEditableTerm,
   * which refuses to write on an archived term, so submitting the closure form
   * in that state would silently bounce back to `?error=...` with nothing on
   * this page rendering it. Disable the controls instead of letting the
   * checkbox appear usable and then mysteriously revert.
   */
  editable: boolean;
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
  closures,
  closureAction,
  editable,
}: ClinicDatesEditorProps): ReactNode {
  const currentIsos = clinicDates.map(toIsoDate);

  return (
    <div className="space-y-4">
      {!editable && (
        <p className="text-sm text-subtle-foreground">
          This term is archived and read-only, so closures cannot be set or cleared here.
        </p>
      )}

      {/* List of dates with per-date remove buttons */}
      <div className="space-y-1">
        {clinicDates.length === 0 && (
          <EmptyState inline>No clinic dates set.</EmptyState>
        )}
        {clinicDates.map((d, idx) => {
          // Remaining dates after removing this one.
          const remaining = currentIsos.filter((_, i) => i !== idx);
          const iso = toIsoDate(d);
          const closure = closures[iso];
          const isClosed = closure?.isClosed ?? false;
          return (
            <div key={iso} className="flex flex-wrap items-center gap-3 py-1">
              <span className="w-52 text-sm">{formatClinicDate(d)}</span>

              {/* Closure is a calendar fact and is owned here, not by Faculty
                  Relations. The date stays in the term either way: a closed
                  Saturday is still staffable (departments run triage on one). */}
              <form action={closureAction} className="flex items-center gap-2">
                <input type="hidden" name="dateKey" value={iso} />
                <label className="flex items-center gap-1.5 text-sm text-foreground-soft">
                  <Checkbox name="isClosed" defaultChecked={isClosed} disabled={!editable} />
                  Closed
                </label>
                <Input
                  type="text"
                  name="closedNote"
                  defaultValue={closure?.closedNote ?? ""}
                  placeholder="Reason (optional)"
                  aria-label={`Closure reason for ${formatClinicDate(d)}`}
                  className="w-56"
                  disabled={!editable}
                />
                <Button type="submit" variant="outline" size="sm" disabled={!editable}>
                  Save
                </Button>
              </form>

              <form action={updateAction}>
                <input type="hidden" name="termId" value={termId} />
                <HiddenDatesField dates={remaining} />
                <ConfirmButton
                  label="Remove"
                  confirmLabel="Remove this date? Any shifts and pending requests on it are cleared."
                />
              </form>
            </div>
          );
        })}
      </div>

      {/* Add a single date */}
      <form action={updateAction} className="flex items-end gap-3">
        <input type="hidden" name="termId" value={termId} />
        {/* existing dates; the action appends the new one */}
        <HiddenDatesField dates={currentIsos} />
        <Field label="Add date">
          <Input type="date" name="addDate" className="w-44" />
        </Field>
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
          <span className="text-xs text-subtle-foreground">
            Replaces all dates with the {saturdayIsos.length} Saturday(s) between the term start and end.
          </span>
        </div>
      </form>
    </div>
  );
}
