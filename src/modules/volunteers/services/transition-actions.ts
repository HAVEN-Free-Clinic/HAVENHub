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
 * re-runs its membership sweep against an already-empty set, guards duplicate
 * DEACTIVATE creation, and gates the passport credential snapshot on a real
 * ACTIVE to OFFBOARDED transition, so a second offboard is a no-op plus an audit
 * row rather than an overwritten service record.
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
  constructor(
    public readonly max: number = MAX_BULK_OFFBOARD,
    /** The action being refused, so the flag path does not say "offboard". */
    verb: "offboard" | "flag" = "offboard",
  ) {
    super(`Select at most ${max} people to ${verb} at once.`);
    this.name = "TransitionBatchTooLargeError";
  }
}

/**
 * The largest batch bulkFlag will accept (audit 14, bulk-flag-uncapped).
 *
 * Deliberately NOT MAX_BULK_OFFBOARD. Flagging is the cheap, reversible half of
 * the transition, and transition-tab.tsx tells the user in so many words to
 * "flag them all now and offboard in batches" when their selection exceeds the
 * offboard cap -- so borrowing 25 here would break the workflow the UI
 * prescribes, on the whole graduating cohort, every term.
 *
 * What still needs bounding is the loop: personIds arrives straight from
 * FormData, flagForOffboarding runs ~6 sequential queries per person, and
 * nothing in the app requires the caller to be a director (the page gates on
 * volunteers.view). An uncapped POST is therefore a cheap way for any
 * signed-in member to make the database do unbounded work, and a batch large
 * enough to exceed the function's wall clock half-applies, since each person
 * commits independently.
 *
 * 250 is ten times the offboard cap: comfortably above a full term roster
 * (low hundreds at launch), roughly 1,500 round trips, and small enough that
 * the loop cannot outrun the platform's default function duration. This page
 * declares no maxDuration; if a roster ever approaches this number, declare one
 * and recalculate rather than just raising it.
 */
export const MAX_BULK_FLAG = 10 * MAX_BULK_OFFBOARD;

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
  if (personIds.length > MAX_BULK_FLAG) {
    throw new TransitionBatchTooLargeError(MAX_BULK_FLAG, "flag");
  }

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
