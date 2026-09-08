/**
 * Putting somebody on a term roster.
 *
 * Lives in platform rather than in the admin module because more than one module
 * now needs it: /admin's roster panels, and the dual-role queue under
 * /volunteers, which adds a volunteer to a SECOND department once the receiving
 * director approves the offer. Modules may not import each other, and the one
 * thing this must not become is two implementations -- the offboard-convergence
 * guard below is exactly the kind of rule that gets remembered in one copy and
 * forgotten in the other.
 *
 * modules/admin/services/roster.ts re-exports all three symbols, so every
 * existing caller and test keeps its import path.
 *
 * Permission checks are NOT this function's concern: callers gate via
 * requirePermission. It takes an explicit actorPersonId for the audit trail.
 */

import { Prisma } from "@prisma/client";
import { prisma } from "@/platform/db";
import { recordAudit } from "@/platform/audit";

export class MembershipForeignKeyError extends Error {
  constructor(public field: string) {
    super(`Invalid reference: ${field}`);
    this.name = "MembershipForeignKeyError";
  }
}

export class OffboardedPersonError extends Error {
  constructor(public personId: string) {
    super("Reactivate this person before adding them to a roster.");
    this.name = "OffboardedPersonError";
  }
}

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
  // Offboard convergence: Person.status OFFBOARDED implies zero ACTIVE
  // memberships (setPersonStatusField holds the other direction by flipping all
  // memberships to REMOVED). Without this check an admin on /admin/people/<id>
  // could "Add assignment" to an offboarded person and put somebody who cannot
  // log in back onto the term roster, the compliance and training rosters, the
  // schedule builder's assignable list, and the Monday shift-reminder cron.
  // The term RosterPanel's person picker already filters to ACTIVE; guarding in
  // the service covers both entry points -- and now the dual-role queue too,
  // where the offer may have been made months before the offboard.
  const target = await prisma.person.findUnique({
    where: { id: input.personId },
    select: { status: true },
  });
  if (target && target.status !== "ACTIVE") throw new OffboardedPersonError(input.personId);

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
