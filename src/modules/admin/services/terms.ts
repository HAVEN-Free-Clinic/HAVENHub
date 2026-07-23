/**
 * Terms service: create, activate (swap), archive, clinic-date management.
 *
 * All mutations accept an explicit actorPersonId for audit. Permission checks
 * are NOT the service's concern -- pages and server actions gate via
 * requirePermission. Services trust their callers and remain testable in
 * isolation.
 *
 * NOTE: Recruitment-driven FA26 roster intake (linking newly recruited people
 * to a term during the intake flow) is deferred to the Recruitment module.
 * NOTE: Module enablement toggles (e.g. disabling the Terms module) are
 * code-driven in the registry; there is no UI toggle here.
 */

import type { Term } from "@prisma/client";
import { Prisma } from "@prisma/client";
import { prisma, isUniqueConstraintError } from "@/platform/db";
import { recordAudit } from "@/platform/audit";

// ---------------------------------------------------------------------------
// Typed errors
// ---------------------------------------------------------------------------

export class TermConflictError extends Error {
  constructor(public code: string) {
    super(`A term with code "${code}" already exists.`);
    this.name = "TermConflictError";
  }
}

export class TermNotFoundError extends Error {
  constructor(public id: string) {
    super(`Term ${id} not found`);
    this.name = "TermNotFoundError";
  }
}

export class TermDateError extends Error {
  constructor(public input: string) {
    super(`Invalid date value: "${input}"`);
    this.name = "TermDateError";
  }
}

export class TermNotActivatableError extends Error {
  constructor(public id: string) {
    super("An archived term cannot be re-activated. Archiving is terminal; create or use a planning term instead.");
    this.name = "TermNotActivatableError";
  }
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Returns every Saturday between startIso and endIso (inclusive), anchored at
 * 12:00:00Z so the date is "Saturday" in every US timezone. Clinic dates MUST
 * be rendered with timeZone: "UTC".
 */
export function saturdaysBetween(startIso: string, endIso: string): Date[] {
  const out: Date[] = [];
  const end = new Date(`${endIso}T12:00:00Z`);
  // Advance to the first Saturday on or after startIso.
  let d = new Date(`${startIso}T12:00:00Z`);
  // getUTCDay() -> 0=Sun 1=Mon ... 6=Sat
  const dayOfWeek = d.getUTCDay();
  if (dayOfWeek !== 6) {
    const daysUntilSaturday = (6 - dayOfWeek + 7) % 7;
    d = new Date(d.getTime() + daysUntilSaturday * 86400000);
  }
  while (d <= end) {
    out.push(new Date(d));
    d = new Date(d.getTime() + 7 * 86400000);
  }
  return out;
}

/**
 * Parse an ISO date string (either YYYY-MM-DD or a full ISO timestamp) and
 * return a new Date anchored at noon UTC for that calendar date.
 *
 * Throws TermDateError when:
 *   (a) the YYYY-MM-DD slice does not match the expected pattern,
 *   (b) the resulting Date is NaN, or
 *   (c) the round-trip check fails (catches impossible dates like Feb 30).
 */
function toNoonUtc(iso: string): Date {
  // Extract the YYYY-MM-DD portion regardless of input format.
  const datePart = iso.slice(0, 10); // "YYYY-MM-DD"
  if (!/^\d{4}-\d{2}-\d{2}$/.test(datePart)) {
    throw new TermDateError(iso);
  }
  const d = new Date(`${datePart}T12:00:00Z`);
  if (isNaN(d.getTime())) {
    throw new TermDateError(iso);
  }
  // Round-trip check: catches overflow dates like 2026-02-30 (JS normalizes
  // these to a valid date in a different month rather than returning NaN).
  if (d.toISOString().slice(0, 10) !== datePart) {
    throw new TermDateError(iso);
  }
  return d;
}

/**
 * Cancel every still-PENDING shift request for a term. Used when a term leaves
 * the decidable set (archived, or its clinic dates change): a PENDING request
 * there can no longer be approved or denied on any surface, so leaving it
 * PENDING is a dead-end the requester and approvers both keep seeing. Optionally
 * scope to a set of removed clinic-date keys, for the updateClinicDates case
 * where only requests on the dropped dates are stale. Returns the number cancelled.
 */
async function cancelStalePendingRequests(
  tx: Prisma.TransactionClient,
  termId: string,
  removedDateKeys?: Set<number>
): Promise<number> {
  const where: Prisma.ShiftRequestWhereInput = { termId, status: "PENDING" };
  if (removedDateKeys) {
    const removed = [...removedDateKeys].map((t) => new Date(t));
    where.OR = [{ requesterDate: { in: removed } }, { targetDate: { in: removed } }];
  }
  // Status only. decidedBy is left unset: this is a system cancellation driven by
  // a term change, not an approve/deny decision, and stamping the actor there
  // would misrepresent them as having denied the request. Who triggered it and
  // why is captured in the term.archive / term.dates audit row instead.
  const { count } = await tx.shiftRequest.updateMany({
    where,
    data: { status: "CANCELLED" },
  });
  return count;
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export async function listTerms(): Promise<(Term & { _count: { memberships: number } })[]> {
  return prisma.term.findMany({
    include: { _count: { select: { memberships: true } } },
    orderBy: { startDate: "desc" },
  });
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

export async function createTerm(
  actorPersonId: string,
  input: { code: string; name: string; startDate: string; endDate: string }
): Promise<Term> {
  const code = input.code.trim().toUpperCase();

  // Case-insensitive duplicate check BEFORE hitting the DB unique constraint so
  // we can surface a consistent TermConflictError even for code variants that
  // differ only in case (the @unique index on code is case-sensitive in
  // Postgres by default).
  const existing = await prisma.term.findFirst({
    where: { code: { equals: code, mode: "insensitive" } },
  });
  if (existing) {
    throw new TermConflictError(code);
  }

  // Validate date strings before any DB work; throws TermDateError on bad input.
  const startDate = toNoonUtc(input.startDate);
  const endDate = toNoonUtc(input.endDate);

  const clinicDates = saturdaysBetween(input.startDate, input.endDate);

  let term: Term;
  try {
    term = await prisma.term.create({
      data: {
        code,
        name: input.name,
        startDate,
        endDate,
        status: "PLANNING",
        clinicDates,
      },
    });
  } catch (err) {
    // Catch P2002 on the @unique(code) in case of a race between findFirst and
    // create (unlikely in practice but required for correctness).
    if (isUniqueConstraintError(err)) {
      throw new TermConflictError(code);
    }
    throw err;
  }

  await recordAudit({
    actorPersonId,
    action: "term.create",
    entityType: "Term",
    entityId: term.id,
    after: { code: term.code, name: term.name, status: term.status },
  });

  return term;
}

export async function activateTerm(actorPersonId: string, id: string): Promise<Term> {
  // Verify target exists first; surface a typed error early.
  const target = await prisma.term.findUnique({ where: { id } });
  if (!target) throw new TermNotFoundError(id);

  // No-op: target is already the ACTIVE term.
  if (target.status === "ACTIVE") {
    return target;
  }

  // ARCHIVED is terminal everywhere else in the app, so re-activating one would
  // resurrect a term no other transition can produce. A term flipped early by
  // mistake is now recoverable a different way: the swap below demotes a
  // displaced future-dated term to PLANNING (not ARCHIVED), so THAT term stays
  // re-activatable. Genuinely-ended terms stay archived and closed.
  if (target.status === "ARCHIVED") {
    throw new TermNotActivatableError(id);
  }

  // Transactional swap: archive the current ACTIVE term (if any), then
  // activate the target. Both status updates happen atomically.
  //
  // Serializable: two concurrent activations must not leave two ACTIVE terms.
  //
  // On a serialization failure Prisma throws P2034; we retry once. If the
  // retry also fails the error is rethrown to the caller.
  // NOTE: No unit test covers the retry path because triggering a genuine
  // serialization conflict requires real concurrent DB sessions.
  const now = new Date();

  async function runSwap() {
    return prisma.$transaction(
      async (tx) => {
        const currentActive = await tx.term.findFirst({
          where: { status: "ACTIVE" },
          orderBy: { startDate: "desc" },
        });

        let displacedTerm: Term | null = null;
        let displacedStatus: "ARCHIVED" | "PLANNING" | null = null;
        let cancelledRequests = 0;
        if (currentActive) {
          // A term whose end date is still in the future is being flipped early
          // (premature or mistaken activation): demote it to PLANNING so it stays
          // recoverable and re-activatable. A term already past its end date is a
          // normal end-of-semester handoff: archive it, and cancel its still-PENDING
          // shift requests, which can no longer be decided anywhere once archived.
          displacedStatus = currentActive.endDate.getTime() > now.getTime() ? "PLANNING" : "ARCHIVED";
          displacedTerm = await tx.term.update({
            where: { id: currentActive.id },
            data: { status: displacedStatus },
          });
          if (displacedStatus === "ARCHIVED") {
            cancelledRequests = await cancelStalePendingRequests(tx, currentActive.id);
          }
        }

        const activatedTerm = await tx.term.update({
          where: { id },
          data: { status: "ACTIVE" },
        });

        return { displacedTerm, displacedStatus, cancelledRequests, activatedTerm };
      },
      { isolationLevel: "Serializable" }
    );
  }

  let swapResult: Awaited<ReturnType<typeof runSwap>>;
  try {
    swapResult = await runSwap();
  } catch (err) {
    if (
      err != null &&
      typeof err === "object" &&
      "code" in err &&
      (err as { code: string }).code === "P2034"
    ) {
      // Retry once on serialization failure.
      swapResult = await runSwap();
    } else {
      throw err;
    }
  }

  const { displacedTerm, displacedStatus, cancelledRequests, activatedTerm } = swapResult;

  // Audit AFTER the transaction commits. recordAudit never throws. The displaced
  // term's action reflects its real outcome: term.archive when it ended, or
  // term.deactivate when it was demoted to PLANNING for recovery.
  if (displacedTerm && displacedStatus) {
    await recordAudit({
      actorPersonId,
      action: displacedStatus === "ARCHIVED" ? "term.archive" : "term.deactivate",
      entityType: "Term",
      entityId: displacedTerm.id,
      before: { status: "ACTIVE" },
      after: { status: displacedStatus, cancelledRequests },
    });
  }

  await recordAudit({
    actorPersonId,
    action: "term.activate",
    entityType: "Term",
    entityId: activatedTerm.id,
    before: { status: target.status },
    after: { status: "ACTIVE" },
  });

  return activatedTerm;
}

export async function archiveTerm(actorPersonId: string, id: string): Promise<Term> {
  const existing = await prisma.term.findUnique({ where: { id } });
  if (!existing) throw new TermNotFoundError(id);

  // No-op: target is already ARCHIVED. Return unchanged, write no audit.
  if (existing.status === "ARCHIVED") {
    return existing;
  }

  // Archiving the only ACTIVE term leaves no active term - this is intentional
  // and allowed. Cancel any still-PENDING shift requests in the same transaction:
  // once the term is archived they can no longer be decided on any surface, so
  // leaving them PENDING is a dead-end for requester and approvers alike.
  const { updated, cancelledRequests } = await prisma.$transaction(async (tx) => {
    const term = await tx.term.update({ where: { id }, data: { status: "ARCHIVED" } });
    const cancelled = await cancelStalePendingRequests(tx, id);
    return { updated: term, cancelledRequests: cancelled };
  });

  await recordAudit({
    actorPersonId,
    action: "term.archive",
    entityType: "Term",
    entityId: id,
    before: { status: existing.status },
    after: { status: "ARCHIVED", cancelledRequests },
  });

  return updated;
}

export async function updateClinicDates(
  actorPersonId: string,
  id: string,
  datesIso: string[]
): Promise<Term> {
  const existing = await prisma.term.findUnique({ where: { id } });
  if (!existing) throw new TermNotFoundError(id);

  // Normalize each input to noon-UTC, dedupe by timestamp value, sort ascending.
  const seen = new Set<number>();
  const normalized: Date[] = [];
  for (const iso of datesIso) {
    const d = toNoonUtc(iso);
    const t = d.getTime();
    if (!seen.has(t)) {
      seen.add(t);
      normalized.push(d);
    }
  }
  normalized.sort((a, b) => a.getTime() - b.getTime());

  const countBefore = existing.clinicDates.length;
  const countAfter = normalized.length;

  // Dates being removed from the calendar. Every write path validates a shift's
  // date against term.clinicDates, but the reads that render a member's shifts do
  // not, so a shift left on a removed date is visible yet can no longer be
  // dropped, swapped, approved, or unassigned. Clean those up in the same
  // transaction as the date change: delete assignments on the removed dates and
  // cancel their still-PENDING requests, so the calendar and the shifts stay
  // consistent. Purely additive edits (no removals) skip all of this.
  const keptKeys = new Set(normalized.map((d) => d.getTime()));
  const removedKeys = new Set(
    existing.clinicDates.map((d) => d.getTime()).filter((t) => !keptKeys.has(t))
  );

  const { updated, removedAssignments, cancelledRequests } = await prisma.$transaction(async (tx) => {
    let removedAssignments = 0;
    let cancelledRequests = 0;
    if (removedKeys.size > 0) {
      const removedDates = [...removedKeys].map((t) => new Date(t));
      const del = await tx.shiftAssignment.deleteMany({
        where: { termId: id, clinicDate: { in: removedDates } },
      });
      removedAssignments = del.count;
      cancelledRequests = await cancelStalePendingRequests(tx, id, removedKeys);
    }
    const term = await tx.term.update({ where: { id }, data: { clinicDates: normalized } });
    return { updated: term, removedAssignments, cancelledRequests };
  });

  // Audit with before/after COUNTS only (not the full arrays), plus the cleanup
  // counts so a date removal that wiped shifts is visible in the log.
  await recordAudit({
    actorPersonId,
    action: "term.dates",
    entityType: "Term",
    entityId: id,
    before: { count: countBefore },
    after: { count: countAfter, removedAssignments, cancelledRequests },
  });

  return updated;
}
