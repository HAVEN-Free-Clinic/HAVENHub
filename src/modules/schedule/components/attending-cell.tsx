/**
 * One cell of the attending schedule grid: a single (clinic date, slot).
 *
 * A slot may carry more than one attending -- the 9am-12pm shift really is
 * covered by two -- so a multi-slot renders one select per assigned attending
 * plus a spare, rather than a single select.
 *
 * Server component, with no client state: the spare select is how another
 * attending is added, and saving the row re-renders with a fresh spare.
 */

import { Select } from "@/platform/ui/select";
import type { ClinicSlotView, SlotCoverage } from "@/modules/schedule/services/attendings";

type Option = { id: string; scheduleName: string; isActive: boolean };

type Props = {
  slot: ClinicSlotView;
  coverage: SlotCoverage | undefined;
  dateKey: string;
  canEdit: boolean;
  options: Option[];
  /** Suppress the editor entirely on a closed date. */
  isClosed: boolean;
};

export function AttendingCell({ slot, coverage, dateKey, canEdit, options, isClosed }: Props) {
  const assigned = coverage?.attendings ?? [];

  if (!canEdit || isClosed) {
    const staffed = assigned.filter((a) => a.isActive);
    return staffed.length === 0 ? (
      <span className="text-subtle-foreground">&mdash;</span>
    ) : (
      <>
        {staffed.map((a) => (
          <span key={a.id} className="block text-foreground">
            {a.scheduleName}
          </span>
        ))}
      </>
    );
  }

  // One select per current assignment, plus one spare so another can be added.
  // A multi-slot posts several `slot:<id>` values, which the parser collects
  // into a list; a single slot posts exactly one.
  const rows = slot.allowsMultiple ? [...assigned.map((a) => a.id), ""] : [assigned[0]?.id ?? ""];

  return (
    <div className="flex flex-col gap-1">
      {rows.map((value, i) => (
        <Select
          key={`${slot.id}-${i}`}
          name={`slot:${slot.id}`}
          defaultValue={value}
          aria-label={
            slot.allowsMultiple
              ? `${slot.label} attending ${i + 1} on ${dateKey}`
              : `${slot.label} attending on ${dateKey}`
          }
          className="text-sm"
        >
          <option value="">&mdash;</option>
          {options.map((a) => (
            <option key={a.id} value={a.id}>
              {a.isActive ? a.scheduleName : `${a.scheduleName} (inactive)`}
            </option>
          ))}
        </Select>
      ))}
    </div>
  );
}
