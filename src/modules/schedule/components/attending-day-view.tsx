/**
 * One clinic date of the attending schedule, with every field it carries.
 *
 * The Day view's counterpart to the grid: the grid fills one column across the
 * term, this fills one date across every column, plus the per-day fields that
 * have nowhere to live in a person x date matrix (specialty clinic, the closure
 * note).
 *
 * Deliberately ONE form per date. A <form> cannot legally wrap <td>s, so laying
 * this out as a table row would force the controls outside the form and
 * associate them by `form=` id -- and a server action serialises only the form's
 * DESCENDANTS, so every one of those controls is silently dropped on submit.
 * The day row saved and its attendings did not.
 *
 * Server component: no "use client" directive.
 */

import { AttendingCell } from "./attending-cell";
import { Alert } from "@/platform/ui/alert";
import { Button } from "@/platform/ui/button";
import { Card } from "@/platform/ui/card";
import { FormActions } from "@/platform/ui/form";
import { Select } from "@/platform/ui/select";
import { formatCalendarDate } from "@/platform/dates";
import type {
  AttendingScheduleRow,
  ClinicSlotView,
  SpecialtyView,
} from "@/modules/schedule/services/attendings";

type Props = {
  row: AttendingScheduleRow;
  slots: ClinicSlotView[];
  specialties: SpecialtyView[];
  options: Array<{ id: string; scheduleName: string; isActive: boolean }>;
  termId: string;
  termName: string;
  editable: boolean;
  /**
   * Who said they can cover THIS date, from AttendingAvailability. Undefined
   * when nobody on the roster has submitted anything for the term, in which case
   * the picker is annotated with nothing at all rather than with "unavailable"
   * for everyone.
   */
  availability?: { stated: Set<string>; available: Set<string> };
  saveAction: (fd: FormData) => Promise<void>;
};

export function AttendingDayView({
  row,
  slots,
  specialties,
  options,
  termId,
  termName,
  editable,
  availability,
  saveAction,
}: Props) {
  const specialtyClinicOptions = specialties.filter((s) => s.runsSpecialtyClinic);
  // A date the term does not list takes the on-call attending and nothing else,
  // which is what upsertClinicDay enforces. Disabling the rest here means the
  // manager is never offered a control whose save would be refused.
  const clinicalEditable = editable && row.isClinicDate && !row.storedClosed;

  return (
    <Card className="space-y-4">
      <form action={saveAction} className="space-y-4">
        <input type="hidden" name="termId" value={termId} />
        <input type="hidden" name="dateKey" value={row.dateKey} />

        <div className="flex flex-wrap items-center justify-between gap-3">
          <h3 className="text-base font-bold text-foreground tabular-nums">
            {formatCalendarDate(row.clinicDate, {
              weekday: "short",
              month: "short",
              day: "numeric",
              year: "numeric",
            })}
          </h3>
          {row.isClosed ? (
            // Read-only: closure is a calendar fact owned by admin.manage_terms and set
            // in Admin > Terms. Faculty Relations must still SEE it -- a closed Saturday
            // is still staffed for triage -- so it is stated here rather than hidden.
            <span className="text-sm text-warning-foreground">
              Clinic closed
              {row.closedNote ? `: ${row.closedNote}` : ""}
            </span>
          ) : null}
        </div>

        {!row.isClinicDate && (
          <Alert tone="info">
            {termName} does not list this date as a clinic date, so the clinic is closed and no
            column can be staffed. The on-call attending is still set here: on call covers the week
            leading up to the next clinic day, which runs through a break week. Add the date in
            Admin &gt; Terms to staff it.
          </Alert>
        )}

        {row.isClinicDate && row.storedClosed && (
          <Alert tone="warning">
            <strong>The clinic is closed this date.</strong>{" "}
            {row.closedNote ?? "No reason was recorded."} Departments can still be
            scheduled for it. Closures are set in Admin &gt; Terms.
          </Alert>
        )}

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {slots.map((slot) => (
            <div key={slot.id} className="space-y-1">
              <span className="block text-xs font-medium text-foreground-soft">
                {slot.label}
                <span className="ml-1 font-normal text-subtle-foreground">
                  {slot.startTime}-{slot.endTime}
                </span>
              </span>
              <AttendingCell
                slot={slot}
                coverage={row.slots.find((c) => c.slotId === slot.id)}
                dateKey={row.dateKey}
                canEdit={clinicalEditable}
                isClosed={row.isClosed}
                options={options}
                availability={availability}
              />
            </div>
          ))}

          <div className="space-y-1">
            {/* On call covers the week LEADING UP TO the next clinic day, which
                is why it sits on this date but is not one of the day's slots --
                and why it stays editable when everything above it is not. */}
            <span className="block text-xs font-medium text-foreground-soft">
              On call
              <span className="ml-1 font-normal text-subtle-foreground">next week</span>
            </span>
            <Select
              name="onCallAttendingId"
              defaultValue={row.onCallAttendingId ?? ""}
              aria-label={`On-call attending for the week after ${row.dateKey}`}
              className="text-sm"
              disabled={!editable}
            >
              <option value="">Not set</option>
              {options.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.isActive ? a.scheduleName : `${a.scheduleName} (inactive)`}
                </option>
              ))}
            </Select>
          </div>

          {/* Director on point and Procedures booked used to sit here. Both were
              reproductive health's, not Faculty Relations': the director is a
              fact about the schedule (the builder now reads it off the DIRECTOR
              assignments), and the booked count is edited in the RHD readiness
              panel, beside the cap warning it drives. */}
          {clinicalEditable && (
            <div className="space-y-1">
              <span className="block text-xs font-medium text-foreground-soft">Specialty clinic</span>
              <Select
                name="specialtyId"
                defaultValue={row.specialtyId ?? ""}
                aria-label={`Specialty clinic on ${row.dateKey}`}
                className="text-sm"
              >
                <option value="">None</option>
                {specialtyClinicOptions.map((sp) => (
                  <option key={sp.id} value={sp.id}>{sp.name}</option>
                ))}
              </Select>
            </div>
          )}
        </div>

        {editable && (
          <FormActions>
            <Button type="submit" variant="outline" size="sm">Save</Button>
          </FormActions>
        )}
      </form>
    </Card>
  );
}
