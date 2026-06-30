/**
 * Roster service: membership management per term.
 *
 * All mutations accept an explicit actorPersonId for audit. Permission checks
 * are NOT the service's concern -- pages and server actions gate via
 * requirePermission. Services trust their callers and remain testable in
 * isolation.
 *
 * NOTE: Recruitment-driven FA26 roster intake (linking newly recruited people
 * to a term during the intake flow) is deferred to the Recruitment module.
 * NOTE: Person merge tooling (deduplication of roster entries) is deferred;
 * duplicates are resolved in Airtable and re-imported via the import pipeline.
 */

import type { Department, Person } from "@prisma/client";
import { Prisma } from "@prisma/client";
import { prisma } from "@/platform/db";
import { recordAudit } from "@/platform/audit";
import { TermNotFoundError } from "./terms";

// ---------------------------------------------------------------------------
// Typed errors
// ---------------------------------------------------------------------------

export class MembershipNotFoundError extends Error {
  constructor(public id: string) {
    super(`Membership ${id} not found`);
    this.name = "MembershipNotFoundError";
  }
}

export class RosterCopyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RosterCopyError";
  }
}

export class MembershipForeignKeyError extends Error {
  constructor(public field: string) {
    super(`Invalid reference: ${field}`);
    this.name = "MembershipForeignKeyError";
  }
}

export class DirectorHasShiftAssignmentsError extends Error {
  constructor(public membershipId: string) {
    super(`Membership ${membershipId} has director shift assignments; resolve them before changing role`);
    this.name = "DirectorHasShiftAssignmentsError";
  }
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/**
 * Returns the ACTIVE roster for a term, grouped by department, sorted by
 * department code ascending. Within each department, directors and volunteers
 * are each sorted by person name ascending.
 */
export async function termRoster(
  termId: string
): Promise<Array<{ department: Department; directors: Person[]; volunteers: Person[] }>> {
  const memberships = await prisma.termMembership.findMany({
    where: { termId, status: "ACTIVE" },
    include: {
      person: true,
      department: true,
    },
  });

  // Group by department
  const byDept = new Map<
    string,
    { department: Department; directors: Person[]; volunteers: Person[] }
  >();

  for (const m of memberships) {
    if (!byDept.has(m.departmentId)) {
      byDept.set(m.departmentId, {
        department: m.department,
        directors: [],
        volunteers: [],
      });
    }
    const group = byDept.get(m.departmentId)!;
    if (m.kind === "DIRECTOR") {
      group.directors.push(m.person);
    } else {
      group.volunteers.push(m.person);
    }
  }

  // Sort each kind list by name, then sort departments by code
  const groups = Array.from(byDept.values());
  for (const group of groups) {
    group.directors.sort((a, b) => a.name.localeCompare(b.name));
    group.volunteers.sort((a, b) => a.name.localeCompare(b.name));
  }
  groups.sort((a, b) => a.department.code.localeCompare(b.department.code));

  return groups;
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

/**
 * Adds a membership to a term. Uses upsert on the compound key
 * (personId, termId, departmentId, kind) so that a previously REMOVED
 * membership is revived to ACTIVE instead of causing a unique violation.
 */
export async function addMembership(
  actorPersonId: string,
  input: {
    personId: string;
    termId: string;
    departmentId: string;
    kind: "DIRECTOR" | "VOLUNTEER";
  }
): Promise<void> {
  let membership;
  try {
    membership = await prisma.termMembership.upsert({
      where: {
        personId_termId_departmentId_kind: {
          personId: input.personId,
          termId: input.termId,
          departmentId: input.departmentId,
          kind: input.kind,
        },
      },
      update: { status: "ACTIVE" },
      create: {
        personId: input.personId,
        termId: input.termId,
        departmentId: input.departmentId,
        kind: input.kind,
        status: "ACTIVE",
      },
    });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2003") {
      throw new MembershipForeignKeyError(
        typeof e.meta?.field_name === "string" ? e.meta.field_name : "unknown"
      );
    }
    throw e;
  }

  await recordAudit({
    actorPersonId,
    action: "roster.add",
    entityType: "TermMembership",
    entityId: membership.id,
    after: {
      personId: input.personId,
      termId: input.termId,
      departmentId: input.departmentId,
      kind: input.kind,
    },
  });
}

/**
 * Soft-deletes a membership by setting status to REMOVED. If the membership
 * is already REMOVED, this is a no-op (no audit written). Throws
 * MembershipNotFoundError when the id does not exist.
 */
export async function removeMembership(
  actorPersonId: string,
  membershipId: string
): Promise<void> {
  const membership = await prisma.termMembership.findUnique({
    where: { id: membershipId },
  });

  if (!membership) {
    throw new MembershipNotFoundError(membershipId);
  }

  // Already removed: no-op, no audit
  if (membership.status === "REMOVED") {
    return;
  }

  await prisma.termMembership.update({
    where: { id: membershipId },
    data: { status: "REMOVED" },
  });

  await recordAudit({
    actorPersonId,
    action: "roster.remove",
    entityType: "TermMembership",
    entityId: membershipId,
    before: { status: membership.status },
    after: { status: "REMOVED" },
  });
}

/** Count of DIRECTOR-role shift assignments a person holds in a term/department. */
async function countDirectorShiftAssignments(
  personId: string,
  termId: string,
  departmentId: string
): Promise<number> {
  return prisma.shiftAssignment.count({
    where: { personId, termId, departmentId, role: "DIRECTOR" },
  });
}

/**
 * Changes a membership's kind (DIRECTOR <-> VOLUNTEER) for its term+department.
 * Because kind is part of the unique key, this revives/creates the target-kind
 * row ACTIVE and soft-removes the old row, transactionally. No-op when already
 * that kind. Refuses to demote a DIRECTOR who still holds DIRECTOR shift
 * assignments in that department/term (builder.ts forbids director shift roles
 * for non-directors), so the caller resolves those first.
 */
export async function changeMembershipKind(
  actorPersonId: string,
  input: { membershipId: string; toKind: "DIRECTOR" | "VOLUNTEER" }
): Promise<void> {
  const membership = await prisma.termMembership.findUnique({
    where: { id: input.membershipId },
  });
  if (!membership) throw new MembershipNotFoundError(input.membershipId);
  if (membership.kind === input.toKind) return;

  if (membership.kind === "DIRECTOR" && input.toKind === "VOLUNTEER") {
    const directorShifts = await countDirectorShiftAssignments(
      membership.personId,
      membership.termId,
      membership.departmentId
    );
    if (directorShifts > 0) throw new DirectorHasShiftAssignmentsError(input.membershipId);
  }

  await prisma.$transaction(async (tx) => {
    await tx.termMembership.upsert({
      where: {
        personId_termId_departmentId_kind: {
          personId: membership.personId,
          termId: membership.termId,
          departmentId: membership.departmentId,
          kind: input.toKind,
        },
      },
      update: { status: "ACTIVE" },
      create: {
        personId: membership.personId,
        termId: membership.termId,
        departmentId: membership.departmentId,
        kind: input.toKind,
        status: "ACTIVE",
      },
    });
    await tx.termMembership.update({
      where: { id: membership.id },
      data: { status: "REMOVED" },
    });
  });

  await recordAudit({
    actorPersonId,
    action: "roster.change_kind",
    entityType: "TermMembership",
    entityId: membership.id,
    before: { kind: membership.kind },
    after: { kind: input.toKind },
  });
}

/**
 * True when removing or demoting this membership would orphan director shift
 * assignments: the membership is a DIRECTOR and the person holds DIRECTOR-role
 * shift assignments in its term and department. Read-only. The assignment-editor
 * panels call this to block removal, mirroring the changeMembershipKind demotion
 * guard. removeMembership itself stays unguarded because offboarding and
 * volunteer self-leave depend on it.
 */
export async function membershipHasDirectorShifts(membershipId: string): Promise<boolean> {
  const membership = await prisma.termMembership.findUnique({ where: { id: membershipId } });
  if (!membership || membership.kind !== "DIRECTOR") return false;
  return (
    (await countDirectorShiftAssignments(
      membership.personId,
      membership.termId,
      membership.departmentId
    )) > 0
  );
}

/**
 * Copies ACTIVE memberships of the specified kinds from a source term to a
 * target term.
 *
 * Skips any person+department+kind combination that already has an ACTIVE
 * membership in the target. Revives REMOVED memberships in the target (counts
 * as copied). Does not copy REMOVED source memberships.
 *
 * When departmentIds is provided and non-empty, only memberships from those
 * departments are considered. When departmentIds is undefined, all departments
 * are copied (existing behavior). When departmentIds is an empty array, throws
 * RosterCopyError("select at least one department").
 *
 * Refuses to copy into an ARCHIVED target term (throws RosterCopyError).
 * Throws TermNotFoundError when the target term does not exist.
 *
 * Writes exactly one audit row `roster.copy` with fromTermId, toTermId, kinds,
 * departments, copied, and skipped counts.
 */
export async function copyRosterFromTerm(
  actorPersonId: string,
  fromTermId: string,
  toTermId: string,
  kinds: Array<"DIRECTOR" | "VOLUNTEER">,
  departmentIds?: string[]
): Promise<{ copied: number; skipped: number }> {
  if (departmentIds !== undefined && departmentIds.length === 0) {
    throw new RosterCopyError("select at least one department");
  }
  // Validate source term
  const sourceTerm = await prisma.term.findUnique({ where: { id: fromTermId } });
  if (!sourceTerm) {
    throw new TermNotFoundError(fromTermId);
  }

  // Validate target term
  const targetTerm = await prisma.term.findUnique({ where: { id: toTermId } });
  if (!targetTerm) {
    throw new TermNotFoundError(toTermId);
  }
  if (targetTerm.status === "ARCHIVED") {
    throw new RosterCopyError("target term is archived");
  }

  // Load ACTIVE source memberships filtered to the requested kinds (and optionally departments)
  const sourceMemberships = await prisma.termMembership.findMany({
    where: {
      termId: fromTermId,
      status: "ACTIVE",
      kind: { in: kinds },
      ...(departmentIds !== undefined ? { departmentId: { in: departmentIds } } : {}),
    },
  });

  // Batch-fetch ALL existing target memberships (any status) up front to avoid N per-row queries
  const existingTargetMemberships = await prisma.termMembership.findMany({
    where: { termId: toTermId },
    select: { personId: true, departmentId: true, kind: true, status: true },
  });

  // Build a lookup Map: "${personId}:${departmentId}:${kind}" -> status
  const existingMap = new Map<string, string>();
  for (const m of existingTargetMemberships) {
    existingMap.set(`${m.personId}:${m.departmentId}:${m.kind}`, m.status);
  }

  let copied = 0;
  let skipped = 0;

  for (const src of sourceMemberships) {
    const key = `${src.personId}:${src.departmentId}:${src.kind}`;
    const existingStatus = existingMap.get(key);

    // Already ACTIVE in target: skip
    if (existingStatus === "ACTIVE") {
      skipped++;
      continue;
    }

    // Upsert: revives REMOVED if present, creates fresh if absent
    await prisma.termMembership.upsert({
      where: {
        personId_termId_departmentId_kind: {
          personId: src.personId,
          termId: toTermId,
          departmentId: src.departmentId,
          kind: src.kind,
        },
      },
      update: { status: "ACTIVE" },
      create: {
        personId: src.personId,
        termId: toTermId,
        departmentId: src.departmentId,
        kind: src.kind,
        status: "ACTIVE",
      },
    });

    copied++;
  }

  // One audit row for the entire copy operation
  await recordAudit({
    actorPersonId,
    action: "roster.copy",
    entityType: "TermMembership",
    after: {
      fromTermId,
      toTermId,
      kinds,
      departments: departmentIds !== undefined ? departmentIds.length : "all",
      copied,
      skipped,
    },
  });

  return { copied, skipped };
}
