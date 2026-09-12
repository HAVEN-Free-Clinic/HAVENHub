import type { MedRole } from "./capacity";

/**
 * Running totals for the builder grid, counted from the board itself.
 *
 * Lives in `engine/` for the same reason `member-order.ts` does: the grid is a
 * CLIENT component, so a runtime helper it calls cannot come out of the service
 * without dragging Prisma into the browser bundle. Pure and I/O-free like
 * `capacity.ts`, and it takes the board it is given rather than reading one,
 * which is what makes the numbers live: the grid renders from `board.assignments`,
 * every optimistic write and every change-stream snapshot replaces that object
 * wholesale, so totals derived from it move on the same tick as the cell.
 *
 * ## The two numbers answer two different questions
 *
 * A row total answers "how many shifts does this person have", which stays true
 * whatever role they hold and stays true after they offboard. A date total
 * answers "how many volunteers cover this clinic", which is coverage: directors
 * are running the day and shadows are learning, so neither counts, and a former
 * member's leftover shift is shown so it can be cleared rather than counted as
 * staffing. `countableIds` is what draws that second line, mirroring
 * `countableMemberIds` in `builderView`.
 *
 * Note the date total is deliberately NOT the Day view's `onShift`, which counts
 * VOLUNTEER plus DIRECTOR (see `computeDayMetrics`). Ops asked the grid for
 * volunteers, so the footer row says "Volunteers" and means it.
 */

/** Just the fields the totals need; any BuilderAssignmentEntry satisfies it. */
export type CountableAssignment = {
  role: "DIRECTOR" | "VOLUNTEER" | "SHADOW";
  tags: Record<MedRole, boolean>;
};

export type PersonTotals = {
  /** Every shift on this person's row, whatever role they hold. */
  shifts: number;
  triage: number;
  walkin: number;
  cc: number;
};

export type BoardTotals = {
  /** Keyed by personId. A person with no shifts is absent, not zeroed. */
  perPerson: Record<string, PersonTotals>;
  /** Volunteers per date key. Every date in `dateKeys` is present, zero included. */
  volunteersByDate: Record<string, number>;
};

const MED_ROLES: readonly MedRole[] = ["triage", "walkin", "cc"];

export function boardTotals({
  assignments,
  dateKeys,
  countableIds,
}: {
  assignments: Record<string, Record<string, CountableAssignment>>;
  /** The term's clinic dates. A shift on any other date is not this term's. */
  dateKeys: readonly string[];
  /** Who counts as coverage: members and incoming, never former members. */
  countableIds: ReadonlySet<string>;
}): BoardTotals {
  const perPerson: Record<string, PersonTotals> = {};
  const volunteersByDate: Record<string, number> = {};

  for (const dateKey of dateKeys) {
    // Seeded before the lookup, so a date nobody is on reports 0 rather than
    // dropping out of the object and rendering as blank.
    volunteersByDate[dateKey] = 0;

    const byPerson = assignments[dateKey];
    if (!byPerson) continue;

    for (const [personId, entry] of Object.entries(byPerson)) {
      const totals = (perPerson[personId] ??= { shifts: 0, triage: 0, walkin: 0, cc: 0 });
      totals.shifts += 1;
      for (const role of MED_ROLES) {
        if (entry.tags[role]) totals[role] += 1;
      }

      if (entry.role === "VOLUNTEER" && countableIds.has(personId)) {
        volunteersByDate[dateKey] += 1;
      }
    }
  }

  return { perPerson, volunteersByDate };
}
