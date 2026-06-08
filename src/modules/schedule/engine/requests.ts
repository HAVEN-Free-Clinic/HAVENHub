/**
 * Schedule request validation and mutation planning.
 *
 * Ported from the legacy HAVEN scheduler on 2026-06-07.
 * Source: server/requests.ts
 *
 * Changes from legacy:
 * - planApply re-targeted: emits AssignmentMutation[] instead of PatchOp[] (Airtable records).
 *   The mutation shape carries (op, personId, dateKey, role) so callers can apply
 *   changes via any persistence layer without knowing Airtable field names.
 * - ScheduleRowForValidation is reused for both validate and planApply (legacy had a
 *   separate ScheduleRowForApply with an Airtable record id field; not needed here).
 * - executeApply and rollback are NOT ported (Airtable-specific, dead in this context).
 * - em-dashes in legacy comments converted to plain dashes.
 */

export type ScheduleRowForValidation = {
  date: string; // ISO Saturday key
  directorIds: string[];
  volunteerIds: string[];
  shadowIds?: string[];
};

export type ValidateInput = {
  scheduleRows: ScheduleRowForValidation[];
  requesterId: string;
  requesterDate: string;
  targetId?: string;
  targetDate?: string;
};

export type ValidationResult = { ok: true } | { ok: false; error: string };

export type Role = "director" | "volunteer" | "shadow";

export function findRoleOnDate(
  rows: ScheduleRowForValidation[],
  personId: string,
  date: string,
): Role | null {
  const row = rows.find((r) => r.date === date);
  if (!row) return null;
  if (row.directorIds.includes(personId)) return "director";
  if (row.volunteerIds.includes(personId)) return "volunteer";
  if (row.shadowIds?.includes(personId)) return "shadow";
  return null;
}

export function validateRequest(input: ValidateInput): ValidationResult {
  const { scheduleRows, requesterId, requesterDate, targetId, targetDate } = input;

  const requesterRole = findRoleOnDate(scheduleRows, requesterId, requesterDate);
  if (!requesterRole) return { ok: false, error: "Not assigned to that shift" };

  const hasTargetId = !!targetId;
  const hasTargetDate = !!targetDate;

  // Shadow shifts: drops only. Named swaps don't make sense because shadows
  // are observers, not a regular slot to trade in or out of.
  if (requesterRole === "shadow") {
    if (hasTargetId || hasTargetDate)
      return { ok: false, error: "Shadow shifts can only be dropped, not swapped" };
    return { ok: true };
  }

  if (!hasTargetId && !hasTargetDate) return { ok: true };
  if (hasTargetId !== hasTargetDate) return { ok: false, error: "Partner is not eligible" };

  if (targetId === requesterId) return { ok: false, error: "Partner is not eligible" };

  const targetRole = findRoleOnDate(
    scheduleRows,
    targetId as string,
    targetDate as string,
  );
  if (!targetRole) return { ok: false, error: "Partner is not eligible" };
  if (targetRole === "shadow") return { ok: false, error: "Partner is not eligible" };
  if (targetRole !== requesterRole) return { ok: false, error: "Partner is not eligible" };

  return { ok: true };
}

// ---------------------------------------------------------------------------
// planApply - re-targeted mutation emitter
// ---------------------------------------------------------------------------

/**
 * Mutation contract: "add" ops are emitted unconditionally (the legacy
 * withAdded dedupe moved to the consumer). The executing service must apply
 * adds idempotently (upsert on the assignment unique key) and guard removes
 * with the role so a concurrent change cannot delete the wrong row.
 */
export type AssignmentMutation =
  | { op: "remove"; personId: string; dateKey: string; role: Role }
  | { op: "add"; personId: string; dateKey: string; role: Role };

// Identical shape today; alias keeps the API name stable if the two diverge later.
export type ApplyInput = ValidateInput;

export function planApply(input: ApplyInput): AssignmentMutation[] {
  const { scheduleRows, requesterId, requesterDate, targetId, targetDate } = input;

  // Service validates before calling planApply, so these are internal invariant guards,
  // not user-facing errors. Deliberate simplification from legacy (which distinguished
  // "row not found" from "person not in row" with two separate messages).
  const requesterRole = findRoleOnDate(scheduleRows, requesterId, requesterDate);
  if (!requesterRole) throw new Error("Requester not assigned to requester date");

  // Drop: single remove.
  if (!targetId || !targetDate) {
    return [{ op: "remove", personId: requesterId, dateKey: requesterDate, role: requesterRole }];
  }

  // Shadow swaps are rejected at validate time; guard here too.
  if (requesterRole === "shadow") {
    throw new Error("Shadow shifts cannot be swapped");
  }

  // Named swap: remove requester from their date, add target there;
  // remove target from their date, add requester there.
  return [
    { op: "remove", personId: requesterId, dateKey: requesterDate, role: requesterRole },
    { op: "add",    personId: targetId,    dateKey: requesterDate, role: requesterRole },
    { op: "remove", personId: targetId,    dateKey: targetDate,    role: requesterRole },
    { op: "add",    personId: requesterId, dateKey: targetDate,    role: requesterRole },
  ];
}
