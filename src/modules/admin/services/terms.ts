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
import { prisma } from "@/platform/db";
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
 */
function toNoonUtc(iso: string): Date {
  // Extract the YYYY-MM-DD portion regardless of input format.
  const datePart = iso.slice(0, 10); // "YYYY-MM-DD"
  return new Date(`${datePart}T12:00:00Z`);
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

  const clinicDates = saturdaysBetween(input.startDate, input.endDate);

  let term: Term;
  try {
    term = await prisma.term.create({
      data: {
        code,
        name: input.name,
        startDate: new Date(`${input.startDate}T12:00:00Z`),
        endDate: new Date(`${input.endDate}T12:00:00Z`),
        status: "PLANNING",
        clinicDates,
      },
    });
  } catch (err) {
    // Catch P2002 on the @unique(code) in case of a race between findFirst and
    // create (unlikely in practice but required for correctness).
    if (
      err != null &&
      typeof err === "object" &&
      "code" in err &&
      (err as { code: string }).code === "P2002"
    ) {
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

  // Transactional swap: archive the current ACTIVE term (if any), then
  // activate the target. Both status updates happen atomically.
  const [displaced, activated] = await prisma.$transaction(async (tx) => {
    const currentActive = await tx.term.findFirst({
      where: { status: "ACTIVE" },
      orderBy: { startDate: "desc" },
    });

    let archivedTerm: Term | null = null;
    if (currentActive) {
      archivedTerm = await tx.term.update({
        where: { id: currentActive.id },
        data: { status: "ARCHIVED" },
      });
    }

    const activatedTerm = await tx.term.update({
      where: { id },
      data: { status: "ACTIVE" },
    });

    return [archivedTerm, activatedTerm];
  });

  // Audit AFTER the transaction commits. recordAudit never throws.
  if (displaced) {
    await recordAudit({
      actorPersonId,
      action: "term.archive",
      entityType: "Term",
      entityId: displaced.id,
      before: { status: "ACTIVE" },
      after: { status: "ARCHIVED" },
    });
  }

  await recordAudit({
    actorPersonId,
    action: "term.activate",
    entityType: "Term",
    entityId: activated.id,
    before: { status: target.status },
    after: { status: "ACTIVE" },
  });

  return activated;
}

export async function archiveTerm(actorPersonId: string, id: string): Promise<Term> {
  const existing = await prisma.term.findUnique({ where: { id } });
  if (!existing) throw new TermNotFoundError(id);

  const updated = await prisma.term.update({
    where: { id },
    data: { status: "ARCHIVED" },
  });

  // Archiving the only ACTIVE term leaves no active term - this is intentional
  // and allowed. The engine handles the no-active-term state gracefully.
  await recordAudit({
    actorPersonId,
    action: "term.archive",
    entityType: "Term",
    entityId: id,
    before: { status: existing.status },
    after: { status: "ARCHIVED" },
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

  const updated = await prisma.term.update({
    where: { id },
    data: { clinicDates: normalized },
  });

  // Audit with before/after COUNTS only (not the full arrays).
  await recordAudit({
    actorPersonId,
    action: "term.dates",
    entityType: "Term",
    entityId: id,
    before: { count: countBefore },
    after: { count: countAfter },
  });

  return updated;
}
