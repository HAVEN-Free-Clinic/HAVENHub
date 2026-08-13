/**
 * One cell of the attending schedule grid: a single (clinic date, service line).
 *
 * Two shapes, chosen by whether the reader manages the line:
 *   - read-only, for everyone else. This is the common case, and the reason the
 *     page exists at all: a volunteer working a shift wants to know who is on it.
 *   - an inline editor, which is how both service lines now schedule attendings.
 *     Procedures render only for the line that books them.
 *
 * Server component. Each cell is its own form so a save touches one date and one
 * line, rather than one giant form where a stale field on an unrelated row rides
 * along with the submit.
 */

import { Button } from "@/platform/ui/button";
import { Input } from "@/platform/ui/input";
import { Select } from "@/platform/ui/select";
import type { AttendingOption, AttendingScheduleCell } from "@/modules/schedule/services/attendings";

type Props = {
  cell: AttendingScheduleCell;
  dateKey: string;
  line: { id: string; name: string; usesProcedures: boolean };
  canEdit: boolean;
  options: AttendingOption[];
  termId: string;
  action: (fd: FormData) => Promise<void>;
};

export function AttendingCell({ cell, dateKey, line, canEdit, options, termId, action }: Props) {
  if (!canEdit) {
    return (
      <>
        {cell.attendingName ? (
          <span className="text-foreground">{cell.attendingName}</span>
        ) : (
          <span className="text-subtle-foreground">Not set</span>
        )}
        {cell.directorName && (
          <span className="block text-xs text-subtle-foreground">Director: {cell.directorName}</span>
        )}
        {line.usesProcedures && cell.proceduresBooked != null && (
          <span className="block text-xs text-subtle-foreground">
            Procedures: {cell.proceduresBooked}
          </span>
        )}
      </>
    );
  }

  return (
    <form action={action} className="flex flex-col gap-1.5">
      <input type="hidden" name="termId" value={termId} />
      <input type="hidden" name="dateKey" value={dateKey} />
      {/* The service line is posted, and upsertRhdClinic re-checks both that it
          IS a service line and that the actor manages it. A crafted post cannot
          reach a line this reader does not manage. */}
      <input type="hidden" name="departmentId" value={line.id} />

      <Select
        name="attendingId"
        defaultValue={cell.attendingId ?? ""}
        aria-label={`Attending for ${line.name} on ${dateKey}`}
        className="text-sm"
      >
        <option value="">-- not set --</option>
        {options.map((a) => (
          <option key={a.id} value={a.id}>
            {a.isActive ? a.scheduleName : `${a.scheduleName} (inactive)`}
          </option>
        ))}
      </Select>

      <Input
        name="directorName"
        type="text"
        defaultValue={cell.directorName ?? ""}
        placeholder="Director on point"
        aria-label={`Director on point for ${line.name} on ${dateKey}`}
        className="text-sm"
      />

      {line.usesProcedures && (
        <Input
          name="proceduresBooked"
          type="number"
          min={0}
          defaultValue={cell.proceduresBooked ?? ""}
          placeholder="Procedures"
          aria-label={`Procedures booked for ${line.name} on ${dateKey}`}
          className="text-sm"
        />
      )}

      <Button type="submit" variant="outline" size="sm" className="self-start">
        Save
      </Button>
    </form>
  );
}
