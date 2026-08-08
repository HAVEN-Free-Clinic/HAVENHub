/**
 * Bulk transition mutations.
 *
 * Both functions LOOP the per-person functions in offboarding.ts. They do not
 * reimplement any part of an offboard: the scope check, the last-admin guard,
 * the per-person audit rows, and the Epic, shift-request, credential, and wallet
 * side effects all come from that single-person path, so the bulk path cannot
 * drift from it.
 *
 * Failure is isolated per person. One refusal never blocks the rest of the
 * batch, and the successes stand. Repeat execution is safe: setPersonStatusField
 * re-runs its membership sweep against an already-empty set and guards duplicate
 * DEACTIVATE creation, so a second offboard is a no-op plus an audit row.
 *
 * Analytics deliberately live at the call site, not here, matching the
 * single-person page action which owns its own captureEvent.
 */

import { prisma } from "@/platform/db";
import { recordAudit } from "@/platform/audit";
import { can } from "@/platform/rbac/engine";
import { log, errorAttrs } from "@/platform/logging";
import { LastAdminError } from "@/platform/rbac/last-admin";
import { PersonNotFoundError } from "@/platform/people";
import { MAX_BULK_OFFBOARD } from "../transition-limits";
import { flagForOffboarding, executeOffboard, OffboardForbiddenError } from "./offboarding";

export class TransitionBatchTooLargeError extends Error {
  constructor(public readonly max: number = MAX_BULK_OFFBOARD) {
    super(`Select at most ${max} people to offboard at once.`);
    this.name = "TransitionBatchTooLargeError";
  }
}

export type BulkOutcome = { personId: string; name: string };
export type BulkSkip = BulkOutcome & { reason: string };
export type BulkResult = { succeeded: BulkOutcome[]; skipped: BulkSkip[] };

/** Names for the result rows, resolved up front so a deleted person still reports. */
async function nameMap(personIds: string[]): Promise<Map<string, string>> {
  const people = await prisma.person.findMany({
    where: { id: { in: personIds } },
    select: { id: true, name: true },
  });
  return new Map(people.map((p) => [p.id, p.name]));
}

function reasonFor(error: unknown, personId: string): string {
  if (error instanceof OffboardForbiddenError) return error.message;
  if (error instanceof LastAdminError) return error.message;
  if (error instanceof PersonNotFoundError) return "Person no longer exists.";
  log.error("[volunteers] bulk transition step failed", errorAttrs(error, { personId }));
  return "Unexpected error, see logs.";
}

export async function bulkFlag(
  actorPersonId: string,
  personIds: string[],
  note?: string
): Promise<BulkResult> {
  const names = await nameMap(personIds);
  const succeeded: BulkOutcome[] = [];
  const skipped: BulkSkip[] = [];

  for (const personId of personIds) {
    const name = names.get(personId) ?? "Unknown person";
    try {
      await flagForOffboarding(actorPersonId, personId, note);
      succeeded.push({ personId, name });
    } catch (error) {
      skipped.push({ personId, name, reason: reasonFor(error, personId) });
    }
  }

  // One summary row for the batch, alongside the per-person offboard.flag rows
  // flagForOffboarding already writes. Mirrors the roster.copy precedent.
  await recordAudit({
    actorPersonId,
    action: "offboard.bulk_flag",
    entityType: "Person",
    after: { requested: personIds.length, flagged: succeeded.length, skipped: skipped.length },
  });

  return { succeeded, skipped };
}

export async function bulkExecuteOffboard(
  actorPersonId: string,
  personIds: string[]
): Promise<BulkResult> {
  if (!(await can(actorPersonId, "volunteers.manage_offboarding"))) {
    throw new OffboardForbiddenError(
      "volunteers.manage_offboarding is required to execute offboarding."
    );
  }
  if (personIds.length > MAX_BULK_OFFBOARD) {
    throw new TransitionBatchTooLargeError();
  }

  const names = await nameMap(personIds);
  const succeeded: BulkOutcome[] = [];
  const skipped: BulkSkip[] = [];

  for (const personId of personIds) {
    const name = names.get(personId) ?? "Unknown person";
    try {
      await executeOffboard(actorPersonId, personId);
      succeeded.push({ personId, name });
    } catch (error) {
      skipped.push({ personId, name, reason: reasonFor(error, personId) });
    }
  }

  await recordAudit({
    actorPersonId,
    action: "offboard.bulk_execute",
    entityType: "Person",
    after: { requested: personIds.length, offboarded: succeeded.length, skipped: skipped.length },
  });

  return { succeeded, skipped };
}
