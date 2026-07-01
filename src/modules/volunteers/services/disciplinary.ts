/**
 * Volunteers module disciplinary service.
 *
 * Permission split:
 *   - issueAction: enforces scope internally. Actor needs
 *     can(actor, "volunteers.issue_disciplinary") OR target has an ACTIVE
 *     membership in the ACTIVE term in one of the actor's manageableDepartmentIds.
 *     No active term + no permission -> DisciplinaryForbiddenError.
 *   - deleteAction: requires can(actor, "volunteers.issue_disciplinary").
 *     Directors cannot delete. Enforced internally.
 *   - listActions: central (issue_disciplinary) sees all. Others see rows for
 *     people in their manageable departments, with confidential rows filtered
 *     to only rows they issued. No manageable depts + no permission -> Forbidden.
 *   - issuablePeople / strikeCount: no permission enforcement; callers gate via
 *     the page layer.
 *
 * All mutations are audited.
 */

import type { DisciplinaryAction, Prisma } from "@prisma/client";
import { prisma } from "@/platform/db";
import { recordAudit } from "@/platform/audit";
import { can } from "@/platform/rbac/engine";
import { manageableDepartmentIds } from "@/platform/departments";
import { getActiveTerm } from "@/platform/terms/active-term";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const DISCIPLINARY_CATEGORIES = [
  "Attendance",
  "Professionalism",
  "Privacy & HIPAA Violations",
  "Patient Safety",
  "Other",
] as const;

// ---------------------------------------------------------------------------
// Typed errors
// ---------------------------------------------------------------------------

export class DisciplinaryForbiddenError extends Error {
  constructor(message = "You do not have permission to perform this disciplinary action.") {
    super(message);
    this.name = "DisciplinaryForbiddenError";
  }
}

export class DisciplinaryNotFoundError extends Error {
  constructor(message = "Disciplinary action not found.") {
    super(message);
    this.name = "DisciplinaryNotFoundError";
  }
}

export class DisciplinaryValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DisciplinaryValidationError";
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DisciplinaryInput = {
  personId: string;
  occurredAt: Date;
  category: string;
  description: string;
  followUpActions?: string | null;
  policyReference?: string | null;
  notes?: string | null;
  confidential?: boolean;
  patientInvolved?: boolean;
};

export type ActionRow = {
  action: DisciplinaryAction;
  personName: string;
  issuedByName: string;
  strikes: number;
};

// ---------------------------------------------------------------------------
// Internal: scope helpers
// ---------------------------------------------------------------------------

/**
 * Returns true if the actor may issue a disciplinary action against the target.
 * Requires either volunteers.issue_disciplinary OR the target having an ACTIVE
 * membership in the ACTIVE term in one of the actor's manageable departments.
 */
async function actorCanManageTarget(
  actorPersonId: string,
  targetPersonId: string,
  activeTerm: { id: string }
): Promise<boolean> {
  if (await can(actorPersonId, "volunteers.issue_disciplinary")) return true;

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

/**
 * Records a disciplinary action against a person.
 *
 * Scope: volunteers.issue_disciplinary OR target has ACTIVE membership in
 * ACTIVE term in one of the actor's manageable departments. No active term +
 * no permission -> DisciplinaryForbiddenError.
 *
 * Validation (DisciplinaryValidationError):
 *   - category must be in DISCIPLINARY_CATEGORIES
 *   - description must be non-blank
 *   - occurredAt must not be in the future
 *
 * Audits disciplinary.issue (entityType "DisciplinaryAction", after:
 * { personId, category, confidential }).
 */
export async function issueAction(
  actorPersonId: string,
  input: DisciplinaryInput
): Promise<DisciplinaryAction> {
  // --- Validation first (fail fast) ---
  if (!(DISCIPLINARY_CATEGORIES as readonly string[]).includes(input.category)) {
    throw new DisciplinaryValidationError(
      `Invalid category "${input.category}". Must be one of: ${DISCIPLINARY_CATEGORIES.join(", ")}.`
    );
  }

  if (!input.description.trim()) {
    throw new DisciplinaryValidationError("Description must not be blank.");
  }

  if (input.occurredAt > new Date()) {
    throw new DisciplinaryValidationError("occurredAt must not be in the future.");
  }

  // --- Person existence check ---
  const person = await prisma.person.findUnique({ where: { id: input.personId } });
  if (!person) throw new DisciplinaryNotFoundError(`Person ${input.personId} not found.`);

  // --- Scope check ---
  // Central permission bypasses the active-term requirement.
  const isCentral = await can(actorPersonId, "volunteers.issue_disciplinary");

  if (!isCentral) {
    const activeTerm = await getActiveTerm();
    if (!activeTerm) {
      throw new DisciplinaryForbiddenError("No active term -- cannot issue disciplinary action.");
    }
    const allowed = await actorCanManageTarget(actorPersonId, input.personId, activeTerm);
    if (!allowed) throw new DisciplinaryForbiddenError();
  }

  // --- Create the record ---
  const action = await prisma.disciplinaryAction.create({
    data: {
      personId: input.personId,
      issuedById: actorPersonId,
      occurredAt: input.occurredAt,
      category: input.category,
      description: input.description,
      followUpActions: input.followUpActions ?? null,
      policyReference: input.policyReference ?? null,
      notes: input.notes ?? null,
      confidential: input.confidential ?? false,
      patientInvolved: input.patientInvolved ?? false,
    },
  });

  await recordAudit({
    actorPersonId,
    action: "disciplinary.issue",
    entityType: "DisciplinaryAction",
    entityId: action.id,
    after: {
      personId: input.personId,
      category: input.category,
      confidential: action.confidential,
    },
  });

  return action;
}

/**
 * Permanently deletes a disciplinary action.
 *
 * Requires volunteers.issue_disciplinary (central only; directors cannot delete).
 * Missing row -> DisciplinaryNotFoundError.
 * Audits disciplinary.delete with the full row snapshot in before.
 */
export async function deleteAction(actorPersonId: string, id: string): Promise<void> {
  if (!(await can(actorPersonId, "volunteers.issue_disciplinary"))) {
    throw new DisciplinaryForbiddenError(
      "volunteers.issue_disciplinary is required to delete disciplinary actions."
    );
  }

  const row = await prisma.disciplinaryAction.findUnique({ where: { id } });
  if (!row) throw new DisciplinaryNotFoundError();

  await prisma.disciplinaryAction.delete({ where: { id } });

  await recordAudit({
    actorPersonId,
    action: "disciplinary.delete",
    entityType: "DisciplinaryAction",
    entityId: id,
    before: {
      id: row.id,
      personId: row.personId,
      issuedById: row.issuedById,
      occurredAt: row.occurredAt.toISOString(),
      category: row.category,
      description: row.description,
      followUpActions: row.followUpActions,
      policyReference: row.policyReference,
      notes: row.notes,
      confidential: row.confidential,
      patientInvolved: row.patientInvolved,
      createdAt: row.createdAt.toISOString(),
    },
  });
}

/**
 * Returns a paginated list of disciplinary actions visible to the viewer.
 *
 * Visibility:
 *   - Central (issue_disciplinary): sees all (canManageAll true).
 *   - Directors: rows where the person has an ACTIVE membership in the ACTIVE
 *     term in one of their manageable departments AND (NOT confidential OR
 *     issuedById === viewer).
 *   - No manageable depts and not central -> DisciplinaryForbiddenError.
 *
 * Filters: departmentId, q (person name contains, case-insensitive), category.
 * For non-central viewers, departmentId must be one of their manageable depts
 * or DisciplinaryForbiddenError is thrown.
 *
 * Page size 25. Sorted newest occurredAt first.
 * Strikes count the actions visible to the viewer: the full total for central
 * viewers, and only non-confidential-or-self-issued actions for directors, so
 * the column never reveals confidential records a director may not see.
 */
export async function listActions(
  viewerPersonId: string,
  q: { departmentId?: string; q?: string; category?: string; page?: number }
): Promise<{ rows: ActionRow[]; total: number; canManageAll: boolean }> {
  const PAGE_SIZE = 25;
  const page = Math.max(1, q.page ?? 1);
  const skip = (page - 1) * PAGE_SIZE;

  const isCentral = await can(viewerPersonId, "volunteers.issue_disciplinary");

  if (isCentral) {
    // Central: see everything. Fetch active term so the dept filter scopes to
    // active-term memberships (consistent with the director path).
    const activeTerm = await getActiveTerm();
    const where = await buildCentralWhere(q, activeTerm);
    const [rows, total] = await Promise.all([
      prisma.disciplinaryAction.findMany({
        where,
        include: {
          person: { select: { id: true, name: true } },
          issuedBy: { select: { name: true } },
        },
        orderBy: { occurredAt: "desc" },
        skip,
        take: PAGE_SIZE,
      }),
      prisma.disciplinaryAction.count({ where }),
    ]);

    const strikeCounts = await loadStrikeCounts(rows.map((r) => r.personId));

    return {
      rows: rows.map((r) => ({
        action: r,
        personName: r.person.name,
        issuedByName: r.issuedBy.name,
        strikes: strikeCounts.get(r.personId) ?? 0,
      })),
      total,
      canManageAll: true,
    };
  }

  // Non-central: need manageable departments.
  const activeTerm = await getActiveTerm();
  const deptIds = activeTerm ? await manageableDepartmentIds(viewerPersonId) : [];

  if (deptIds.length === 0) {
    throw new DisciplinaryForbiddenError();
  }

  // If departmentId filter provided, it must be one of the viewer's depts.
  if (q.departmentId && !deptIds.includes(q.departmentId)) {
    throw new DisciplinaryForbiddenError(
      "You can only filter by a department you manage."
    );
  }

  // The set of departments to scope to.
  const scopeDeptIds = q.departmentId ? [q.departmentId] : deptIds;

  // Find person ids who have ACTIVE memberships in ACTIVE term in scoped depts.
  const memberships = activeTerm
    ? await prisma.termMembership.findMany({
        where: {
          termId: activeTerm.id,
          departmentId: { in: scopeDeptIds },
          status: "ACTIVE",
        },
        select: { personId: true },
      })
    : [];

  const scopedPersonIds = [...new Set(memberships.map((m) => m.personId))];

  if (scopedPersonIds.length === 0) {
    return { rows: [], total: 0, canManageAll: false };
  }

  // Build where for non-central: person in scope + visibility rule.
  const where = buildDirectorWhere(viewerPersonId, scopedPersonIds, q);

  const [rows, total] = await Promise.all([
    prisma.disciplinaryAction.findMany({
      where,
      include: {
        person: { select: { id: true, name: true } },
        issuedBy: { select: { name: true } },
      },
      orderBy: { occurredAt: "desc" },
      skip,
      take: PAGE_SIZE,
    }),
    prisma.disciplinaryAction.count({ where }),
  ]);

  // Count strikes through the same visibility predicate as the rows so the
  // Strikes column does not leak confidential actions raised by others.
  const strikeCounts = await loadStrikeCounts(
    rows.map((r) => r.personId),
    directorVisibility(viewerPersonId)
  );

  return {
    rows: rows.map((r) => ({
      action: r,
      personName: r.person.name,
      issuedByName: r.issuedBy.name,
      strikes: strikeCounts.get(r.personId) ?? 0,
    })),
    total,
    canManageAll: false,
  };
}

/**
 * Resolves the set of person ids that have an ACTIVE membership in the given
 * department in the ACTIVE term. Used to support the departmentId filter for
 * central viewers without relying on a nested relation filter that Prisma
 * doesn't support on count().
 *
 * When there is no active term, returns an empty array so the caller produces
 * zero rows rather than crashing.
 */
async function personIdsInDepartment(
  departmentId: string,
  activeTerm: { id: string } | null
): Promise<string[]> {
  if (!activeTerm) return [];
  const memberships = await prisma.termMembership.findMany({
    where: { departmentId, termId: activeTerm.id, status: "ACTIVE" },
    select: { personId: true },
  });
  return [...new Set(memberships.map((m) => m.personId))];
}

/** Build Prisma where clause for central viewers. */
async function buildCentralWhere(
  q: { departmentId?: string; q?: string; category?: string },
  activeTerm: { id: string } | null
): Promise<Prisma.DisciplinaryActionWhereInput> {
  const where: Prisma.DisciplinaryActionWhereInput = {};

  if (q.category) where.category = q.category;

  if (q.q) {
    where.person = { name: { contains: q.q, mode: "insensitive" } };
  }

  if (q.departmentId) {
    // Resolve person ids in the department's active term (count() doesn't
    // support nested relation filters on the person side).
    // When both q and departmentId are set, `person` (relation filter) and
    // `personId` (FK filter) are ANDed together by Prisma, so only actions
    // whose person matches the name search AND is in the department appear.
    const personIds = await personIdsInDepartment(q.departmentId, activeTerm);
    where.personId = { in: personIds };
  }

  return where;
}

/**
 * Visibility predicate for non-central viewers: a director may see a row only
 * if it is NOT confidential OR they issued it themselves. Shared between the
 * row query (buildDirectorWhere) and the strike count (loadStrikeCounts) so the
 * Strikes column never reveals confidential actions raised by others.
 */
function directorVisibility(viewerPersonId: string): Prisma.DisciplinaryActionWhereInput {
  return { OR: [{ confidential: false }, { issuedById: viewerPersonId }] };
}

/** Build Prisma where clause for non-central viewers. */
function buildDirectorWhere(
  viewerPersonId: string,
  scopedPersonIds: string[],
  q: { q?: string; category?: string }
): Prisma.DisciplinaryActionWhereInput {
  const where: Prisma.DisciplinaryActionWhereInput = {
    personId: { in: scopedPersonIds },
    ...directorVisibility(viewerPersonId),
  };

  if (q.category) where.category = q.category;

  if (q.q) {
    where.person = { name: { contains: q.q, mode: "insensitive" } };
  }

  return where;
}

/**
 * Returns a Map<personId, count> for the given person ids.
 * One groupBy query; no N+1.
 *
 * Pass `visibility` to scope the count to the rows the viewer is permitted to
 * see (e.g. the director visibility predicate). Central viewers pass nothing
 * and get the unfiltered total.
 */
async function loadStrikeCounts(
  personIds: string[],
  visibility?: Prisma.DisciplinaryActionWhereInput
): Promise<Map<string, number>> {
  if (personIds.length === 0) return new Map();

  const groups = await prisma.disciplinaryAction.groupBy({
    by: ["personId"],
    where: { personId: { in: personIds }, ...visibility },
    _count: { _all: true },
  });

  return new Map(groups.map((g) => [g.personId, g._count._all]));
}

/**
 * Returns the set of people against whom the actor may issue a disciplinary
 * action via the UI form.
 *
 * Central (issue_disciplinary): { all: true, people: [] } -- the UI shows a
 * free-text search instead.
 *
 * Directors: ACTIVE members (all membership kinds: VOLUNTEER and DIRECTOR alike) of manageable departments in the
 * active term, deduped, each with departmentNames, sorted by name. The actor
 * is excluded from their own picker (self-issue prevention in the UI); note
 * that issueAction itself does not block self-issue, so central roles can
 * still issue against themselves via the free search.
 *
 * No directorships -> { all: false, people: [] }.
 */
export async function issuablePeople(actorPersonId: string): Promise<{
  all: boolean;
  people: Array<{ id: string; name: string | null; departmentNames: string[] }>;
}> {
  if (await can(actorPersonId, "volunteers.issue_disciplinary")) {
    return { all: true, people: [] };
  }

  const activeTerm = await getActiveTerm();
  if (!activeTerm) return { all: false, people: [] };

  const deptIds = await manageableDepartmentIds(actorPersonId);
  if (deptIds.length === 0) return { all: false, people: [] };

  const memberships = await prisma.termMembership.findMany({
    where: {
      termId: activeTerm.id,
      departmentId: { in: deptIds },
      status: "ACTIVE",
      // Exclude the actor themselves; you cannot issue against yourself.
      personId: { not: actorPersonId },
    },
    include: {
      person: { select: { id: true, name: true } },
      department: { select: { name: true } },
    },
  });

  // Dedupe by personId; collect all dept names per person.
  const peopleMap = new Map<
    string,
    { id: string; name: string | null; departmentNames: Set<string> }
  >();

  for (const m of memberships) {
    const existing = peopleMap.get(m.personId);
    if (existing) {
      existing.departmentNames.add(m.department.name);
    } else {
      peopleMap.set(m.personId, {
        id: m.personId,
        name: m.person.name,
        departmentNames: new Set([m.department.name]),
      });
    }
  }

  const people = [...peopleMap.values()]
    .map((p) => ({
      id: p.id,
      name: p.name,
      departmentNames: [...p.departmentNames].sort(),
    }))
    .sort((a, b) => (a.name ?? "").localeCompare(b.name ?? ""));

  return { all: false, people };
}

/**
 * Returns the total count of DisciplinaryAction rows for a person.
 * Visibility-independent: counts all records regardless of confidentiality.
 */
export async function strikeCount(personId: string): Promise<number> {
  return prisma.disciplinaryAction.count({ where: { personId } });
}
