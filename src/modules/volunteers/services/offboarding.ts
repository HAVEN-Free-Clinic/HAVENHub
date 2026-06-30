/**
 * Volunteers module offboarding service.
 *
 * Two-step workflow:
 *   1. Directors (or manage_offboarding holders) flag a person for offboarding.
 *   2. A manage_offboarding holder executes the offboard: removes all ACTIVE
 *      memberships and sets the person's status to OFFBOARDED.
 *
 * Scope rules for flag/unflag:
 *   - Actor may act if can(actor, "volunteers.manage_offboarding"), OR
 *   - The target person has an ACTIVE membership in the ACTIVE term in one of
 *     the actor's manageable department ids (own directorships + one-hop
 *     delegations).
 *   - When no active term exists the operation is always forbidden.
 *
 * executeOffboard additionally requires can(actor, "volunteers.manage_offboarding")
 * as a defense-in-depth check (the page action checks too).
 *
 * Design note: unlike compliance.ts (which trusts callers entirely), this service
 * enforces scope internally because flag/unflag scope depends on the actor's
 * department graph and cannot be pre-checked at the call site.
 *
 * All mutations are audited. executeOffboard flips Person.status FIRST (via
 * setPersonStatusField, which atomically removes ACTIVE memberships) and deletes
 * the OffboardFlag rows only afterwards, so a partial failure never leaves a
 * person off every roster yet still ACTIVE and unflagged (see executeOffboard).
 */

import type { Department, OffboardFlag, Person } from "@prisma/client";
import { prisma } from "@/platform/db";
import { recordAudit } from "@/platform/audit";
import { can } from "@/platform/rbac/engine";
import { manageableDepartmentIds } from "@/platform/departments";
import { setPersonStatusField } from "@/platform/people";
import { getActiveTerm } from "@/platform/terms/active-term";

// ---------------------------------------------------------------------------
// Typed errors
// ---------------------------------------------------------------------------

export class OffboardForbiddenError extends Error {
  constructor(message = "You do not have permission to perform this offboarding action.") {
    super(message);
    this.name = "OffboardForbiddenError";
  }
}

export class OffboardNotFoundError extends Error {
  constructor(message = "Offboard flag not found.") {
    super(message);
    this.name = "OffboardNotFoundError";
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type FlaggedRow = {
  flag: OffboardFlag;
  person: Person;
  flaggedByName: string | null;
  departmentNames: string[];
};

export type DepartmentMember = {
  person: Person;
  kind: "DIRECTOR" | "VOLUNTEER";
  flag: OffboardFlag | null;
};

export type DepartmentOffboarding = {
  department: Department;
  members: DepartmentMember[];
};

// ---------------------------------------------------------------------------
// Internal: scope check
// ---------------------------------------------------------------------------

/**
 * Returns true when the actor may flag/unflag the target person.
 * Requires either manage_offboarding permission OR the target having an ACTIVE
 * membership in the active term in one of the actor's manageable departments.
 */
async function actorCanManageTarget(
  actorPersonId: string,
  targetPersonId: string,
  activeTerm: { id: string }
): Promise<boolean> {
  if (await can(actorPersonId, "volunteers.manage_offboarding")) return true;

  const deptIds = await manageableDepartmentIds(actorPersonId);
  if (deptIds.length === 0) return false;

  const membership = await prisma.termMembership.findFirst({
    where: {
      personId: targetPersonId,
      termId: activeTerm.id,
      departmentId: { in: deptIds },
      status: "ACTIVE",
    },
  });

  return membership !== null;
}

// ---------------------------------------------------------------------------
// flagForOffboarding
// ---------------------------------------------------------------------------

/**
 * Flags a person for offboarding in the current active term.
 *
 * Upsert-safe on (personId, activeTerm.id): if a flag already exists the
 * existing row is returned and NO second audit entry is written. Audits
 * "offboard.flag" with the note included in the "after" payload.
 *
 * Throws OffboardForbiddenError when no active term exists or the actor lacks
 * scope. Never throws a unique-constraint error.
 */
export async function flagForOffboarding(
  actorPersonId: string,
  personId: string,
  note?: string
): Promise<OffboardFlag> {
  const activeTerm = await getActiveTerm();
  if (!activeTerm) throw new OffboardForbiddenError("No active term -- cannot flag for offboarding.");

  const allowed = await actorCanManageTarget(actorPersonId, personId, activeTerm);
  if (!allowed) throw new OffboardForbiddenError();

  // Check for an existing flag first (upsert-safe, avoids double audit).
  const existing = await prisma.offboardFlag.findUnique({
    where: { personId_termId: { personId, termId: activeTerm.id } },
  });
  if (existing) return existing;

  const flag = await prisma.offboardFlag.create({
    data: {
      personId,
      termId: activeTerm.id,
      flaggedById: actorPersonId,
      note: note ?? null,
    },
  });

  await recordAudit({
    actorPersonId,
    action: "offboard.flag",
    entityType: "OffboardFlag",
    entityId: flag.id,
    after: { personId, termId: activeTerm.id, note: note ?? null },
  });

  return flag;
}

// ---------------------------------------------------------------------------
// unflag
// ---------------------------------------------------------------------------

/**
 * Removes an offboard flag for the person in the active term.
 *
 * Throws OffboardForbiddenError when no active term or actor lacks scope.
 * Throws OffboardNotFoundError when no flag exists to remove.
 * Audits "offboard.unflag".
 */
export async function unflag(actorPersonId: string, personId: string): Promise<void> {
  const activeTerm = await getActiveTerm();
  if (!activeTerm) throw new OffboardForbiddenError("No active term -- cannot unflag.");

  const allowed = await actorCanManageTarget(actorPersonId, personId, activeTerm);
  if (!allowed) throw new OffboardForbiddenError();

  const existing = await prisma.offboardFlag.findUnique({
    where: { personId_termId: { personId, termId: activeTerm.id } },
  });
  if (!existing) throw new OffboardNotFoundError();

  await prisma.offboardFlag.delete({
    where: { personId_termId: { personId, termId: activeTerm.id } },
  });

  await recordAudit({
    actorPersonId,
    action: "offboard.unflag",
    entityType: "OffboardFlag",
    entityId: existing.id,
    after: { personId, termId: activeTerm.id },
  });
}

// ---------------------------------------------------------------------------
// executeOffboard
// ---------------------------------------------------------------------------

/**
 * Executes the offboard for a person:
 *   1. Flip Person.status to OFFBOARDED via setPersonStatusField. That call
 *      atomically removes ALL ACTIVE TermMemberships (any term) and handles Epic
 *      revocation, and owns its own "person.offboard" audit entry.
 *   2. Only AFTER the status flip has committed, delete the person's OffboardFlag
 *      rows.
 *   3. Audit "offboard.execute" with { removedMemberships: n } in "after"
 *      (setPersonStatusField already emits "person.offboard" for the status flip).
 *
 * Ordering rationale (#98): the flag deletion is deliberately the LAST step.
 * setPersonStatusField does its membership removal and status flip in a single
 * transaction, so if it fails nothing is committed -- the person stays ACTIVE,
 * on the roster, AND flagged, so they remain visible in the offboarding queue
 * and the executor can simply retry. Deleting the flags first (the old order)
 * could leave an ACTIVE person on no roster with no flag: a contradictory record
 * invisible to the offboarding screen. If instead the final flag deletion fails,
 * the person is already OFFBOARDED and merely lingers in the flagged list -- a
 * benign, retriable state, never an invisible half-state.
 *
 * The removedMemberships count is captured up front (setPersonStatusField owns
 * the actual removal); it only annotates the audit row.
 *
 * Throws OffboardForbiddenError when actor lacks volunteers.manage_offboarding.
 */
export async function executeOffboard(actorPersonId: string, personId: string): Promise<void> {
  if (!(await can(actorPersonId, "volunteers.manage_offboarding"))) {
    throw new OffboardForbiddenError("volunteers.manage_offboarding is required to execute offboarding.");
  }

  // Count ACTIVE memberships before the flip; setPersonStatusField removes them.
  const removedCount = await prisma.termMembership.count({
    where: { personId, status: "ACTIVE" },
  });

  // 1. Flip status (atomically removes memberships + handles Epic). Flags stay.
  await setPersonStatusField(actorPersonId, personId, "OFFBOARDED");

  // 2. Status is durably OFFBOARDED -- now delete the flags (the safe last step).
  await prisma.offboardFlag.deleteMany({ where: { personId } });

  // 3. Audit the offboard execution with membership count.
  // Note: setPersonStatusField already emits "person.offboard" for the status
  // change; we use "offboard.execute" here to record the membership removal
  // count without creating a duplicate "person.offboard" entry.
  await recordAudit({
    actorPersonId,
    action: "offboard.execute",
    entityType: "Person",
    entityId: personId,
    after: { removedMemberships: removedCount },
  });
}

// ---------------------------------------------------------------------------
// offboardingView
// ---------------------------------------------------------------------------

/**
 * Returns a combined view for the offboarding page.
 *
 * departments: one entry per department in the viewer's manageableDepartmentIds
 *   (active term). Each entry has all ACTIVE memberships with flag (if any).
 *   Members are sorted alphabetically by name.
 *
 * flagged: when the viewer has volunteers.manage_offboarding, the clinic-wide
 *   list of all flagged people (in the active term), sorted by flag.createdAt
 *   asc; each row includes the flaggedByName and the person's active-term
 *   department names. null when the viewer lacks the permission.
 */
export async function offboardingView(viewerPersonId: string): Promise<{
  departments: DepartmentOffboarding[];
  flagged: FlaggedRow[] | null;
}> {
  const activeTerm = await getActiveTerm();
  if (!activeTerm) return { departments: [], flagged: null };

  // --- Director cards ---
  const deptIds = await manageableDepartmentIds(viewerPersonId);

  let departments: DepartmentOffboarding[] = [];

  if (deptIds.length > 0) {
    const deptRows = await prisma.department.findMany({
      where: { id: { in: deptIds } },
      orderBy: { code: "asc" },
    });

    const memberships = await prisma.termMembership.findMany({
      where: {
        termId: activeTerm.id,
        departmentId: { in: deptIds },
        status: "ACTIVE",
      },
      include: { person: true },
    });

    // Collect all person ids across these memberships to load flags in one query.
    const personIds = [...new Set(memberships.map((m) => m.personId))];

    const flags = personIds.length > 0
      ? await prisma.offboardFlag.findMany({
          where: { personId: { in: personIds }, termId: activeTerm.id },
        })
      : [];

    const flagByPersonId = new Map(flags.map((f) => [f.personId, f]));

    const deptMap = new Map<string, DepartmentMember[]>();
    for (const d of deptRows) deptMap.set(d.id, []);

    for (const m of memberships) {
      const list = deptMap.get(m.departmentId);
      if (!list) continue;
      list.push({
        person: m.person,
        kind: m.kind,
        flag: flagByPersonId.get(m.personId) ?? null,
      });
    }

    departments = deptRows.map((d) => {
      const members = (deptMap.get(d.id) ?? []).sort((a, b) =>
        (a.person.name ?? "").localeCompare(b.person.name ?? "")
      );
      return { department: d, members };
    });
  }

  // --- Flagged (executor) section ---
  const isExecutor = await can(viewerPersonId, "volunteers.manage_offboarding");
  if (!isExecutor) return { departments, flagged: null };

  const allFlags = await prisma.offboardFlag.findMany({
    where: { termId: activeTerm.id },
    include: {
      person: true,
      flaggedBy: { select: { name: true } },
    },
    orderBy: { createdAt: "asc" },
  });

  if (allFlags.length === 0) return { departments, flagged: [] };

  // For each flagged person, resolve their ACTIVE memberships in the active term
  // to get department names. One query, then group in JS.
  const flaggedPersonIds = allFlags.map((f) => f.personId);

  const flaggedMemberships = await prisma.termMembership.findMany({
    where: {
      personId: { in: flaggedPersonIds },
      termId: activeTerm.id,
      status: "ACTIVE",
    },
    include: { department: { select: { name: true } } },
  });

  const deptNamesByPersonId = new Map<string, string[]>();
  for (const m of flaggedMemberships) {
    const list = deptNamesByPersonId.get(m.personId) ?? [];
    list.push(m.department.name);
    deptNamesByPersonId.set(m.personId, list);
  }

  const flagged: FlaggedRow[] = allFlags.map((f) => ({
    flag: {
      id: f.id,
      personId: f.personId,
      termId: f.termId,
      flaggedById: f.flaggedById,
      note: f.note,
      createdAt: f.createdAt,
    },
    person: f.person,
    flaggedByName: f.flaggedBy.name ?? null,
    departmentNames: (deptNamesByPersonId.get(f.personId) ?? []).sort(),
  }));

  return { departments, flagged };
}
