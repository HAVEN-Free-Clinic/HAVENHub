/**
 * Departments service: create, update (name/active/capacity), delegation editing.
 * Mirrors terms.ts -- typed errors, actor-scoped mutations that audit. Permission
 * checks are the caller's job. Code is immutable after creation; removal is soft
 * (isActive=false).
 */
import type { Department, EpicRequirement, Prisma } from "@prisma/client";
import { prisma, isUniqueConstraintError } from "@/platform/db";
import { recordAudit } from "@/platform/audit";
import { getActiveTerm } from "@/platform/terms/active-term";

const CODE_RE = /^[A-Z0-9]{2,12}$/;

export class DepartmentConflictError extends Error {
  constructor(public code: string) {
    super(`A department with code "${code}" already exists.`);
    this.name = "DepartmentConflictError";
  }
}
export class DepartmentNotFoundError extends Error {
  constructor(public id: string) {
    super(`Department ${id} not found.`);
    this.name = "DepartmentNotFoundError";
  }
}
export class DepartmentValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DepartmentValidationError";
  }
}

export type DepartmentRow = Department & {
  _count: { memberships: number };
  managesDelegations: { managedDepartmentId: string }[];
};

/** All departments, active first then by code, with membership counts + managed ids.
 *  The "Members" count is the CURRENT active-term headcount: Department.memberships
 *  spans every term and status, so an unscoped _count inflated the column with
 *  archived-term and REMOVED rows. Scope it to ACTIVE memberships in the active term
 *  (0 when there is no active term). */
export async function listDepartments(): Promise<DepartmentRow[]> {
  const activeTerm = await getActiveTerm();
  const membershipWhere: Prisma.TermMembershipWhereInput = activeTerm
    ? { status: "ACTIVE", termId: activeTerm.id }
    : { status: "ACTIVE", termId: "__none__" };
  return prisma.department.findMany({
    include: {
      _count: { select: { memberships: { where: membershipWhere } } },
      managesDelegations: { select: { managedDepartmentId: true } },
    },
    orderBy: [{ isActive: "desc" }, { code: "asc" }],
  });
}

function validateCapacity(label: string, v: number | null): number | null {
  if (v === null) return null;
  if (!Number.isInteger(v) || v <= 0) {
    throw new DepartmentValidationError(`${label} must be a positive whole number.`);
  }
  return v;
}

export async function createDepartment(
  actorPersonId: string,
  input: {
    code: string;
    name: string;
    isActive?: boolean;
    idealHeadcount?: number | null;
    patientCapacityPerProvider?: number | null;
    // Per-track Epic requirement driving the onboarding contract's Epic section
    // (see contract/epic-requirement.ts). Absent → NONE, matching the column default.
    requiresEpicDirector?: EpicRequirement;
    requiresEpicVolunteer?: EpicRequirement;
    /** Absent → false, matching the column default: a new department never
     *  silently bypasses committee scoring. */
    autoRouteApplicants?: boolean;
    /** Absent → true, matching the column default: a new department never
     *  silently blocks its members from dropping a shift. */
    allowShiftDrop?: boolean;
    /** Absent → null ("not recorded"), never a guessed default. */
    hoursPerShift?: number | null;
  }
): Promise<Department> {
  const code = input.code.trim().toUpperCase();
  if (!CODE_RE.test(code)) {
    throw new DepartmentValidationError(
      "Code must be 2-12 uppercase letters or digits (e.g. SCTS)."
    );
  }
  const name = input.name.trim();
  if (!name) throw new DepartmentValidationError("Name is required.");
  const idealHeadcount = validateCapacity("Ideal headcount", input.idealHeadcount ?? null);
  const patientCapacityPerProvider = validateCapacity(
    "Patient capacity per provider",
    input.patientCapacityPerProvider ?? null
  );
  const requiresEpicDirector = input.requiresEpicDirector ?? "NONE";
  const requiresEpicVolunteer = input.requiresEpicVolunteer ?? "NONE";

  const existing = await prisma.department.findFirst({
    where: { code: { equals: code, mode: "insensitive" } },
  });
  if (existing) throw new DepartmentConflictError(code);

  let dept: Department;
  try {
    dept = await prisma.department.create({
      data: {
        code, name, isActive: input.isActive ?? true, idealHeadcount, patientCapacityPerProvider,
        requiresEpicDirector, requiresEpicVolunteer,
        autoRouteApplicants: input.autoRouteApplicants ?? false,
        allowShiftDrop: input.allowShiftDrop ?? true,
        hoursPerShift: input.hoursPerShift ?? null,
      },
    });
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      throw new DepartmentConflictError(code);
    }
    throw err;
  }

  await recordAudit({
    actorPersonId,
    action: "department.create",
    entityType: "Department",
    entityId: dept.id,
    // Record the capacity fields the department was provisioned with, matching the
    // update-path audit shape (which captures every later change to them).
    after: {
      code: dept.code,
      name: dept.name,
      isActive: dept.isActive,
      idealHeadcount: dept.idealHeadcount,
      patientCapacityPerProvider: dept.patientCapacityPerProvider,
      requiresEpicDirector: dept.requiresEpicDirector,
      requiresEpicVolunteer: dept.requiresEpicVolunteer,
      allowShiftDrop: dept.allowShiftDrop,
    },
  });
  return dept;
}

export async function updateDepartment(
  actorPersonId: string,
  id: string,
  input: {
    name: string;
    isActive: boolean;
    idealHeadcount: number | null;
    patientCapacityPerProvider: number | null;
    // Optional so an update that does not touch Epic preserves the existing
    // values rather than resetting them to NONE.
    requiresEpicDirector?: EpicRequirement;
    requiresEpicVolunteer?: EpicRequirement;
    /** Optional for the same reason as the Epic values: an update that does not
     *  touch it must preserve it rather than silently turning it off. */
    autoRouteApplicants?: boolean;
    /** Optional for the same reason: an update that does not touch it must
     *  preserve it rather than silently re-opening drops. */
    allowShiftDrop?: boolean;
    /** Hours one shift is worth, for service records. Explicit null clears it
     *  back to "not recorded"; undefined leaves it untouched. */
    hoursPerShift?: number | null;
  }
): Promise<Department> {
  const before = await prisma.department.findUnique({ where: { id } });
  if (!before) throw new DepartmentNotFoundError(id);

  const name = input.name.trim();
  if (!name) throw new DepartmentValidationError("Name is required.");
  const idealHeadcount = validateCapacity("Ideal headcount", input.idealHeadcount);
  const patientCapacityPerProvider = validateCapacity(
    "Patient capacity per provider",
    input.patientCapacityPerProvider
  );
  const requiresEpicDirector = input.requiresEpicDirector ?? before.requiresEpicDirector;
  const requiresEpicVolunteer = input.requiresEpicVolunteer ?? before.requiresEpicVolunteer;
  const autoRouteApplicants = input.autoRouteApplicants ?? before.autoRouteApplicants;
  const allowShiftDrop = input.allowShiftDrop ?? before.allowShiftDrop;
  // Explicit null clears; undefined preserves. A negative value is rejected
  // rather than stored: a service record must never claim negative hours.
  if (input.hoursPerShift !== undefined && input.hoursPerShift !== null && input.hoursPerShift < 0) {
    throw new DepartmentValidationError("Hours per shift cannot be negative.");
  }
  const hoursPerShift = input.hoursPerShift === undefined ? before.hoursPerShift : input.hoursPerShift;

  const dept = await prisma.department.update({
    where: { id },
    data: { name, isActive: input.isActive, idealHeadcount, patientCapacityPerProvider, requiresEpicDirector, requiresEpicVolunteer, autoRouteApplicants, allowShiftDrop, hoursPerShift },
  });

  await recordAudit({
    actorPersonId,
    action: "department.update",
    entityType: "Department",
    entityId: id,
    before: {
      name: before.name,
      isActive: before.isActive,
      idealHeadcount: before.idealHeadcount,
      patientCapacityPerProvider: before.patientCapacityPerProvider,
      requiresEpicDirector: before.requiresEpicDirector,
      requiresEpicVolunteer: before.requiresEpicVolunteer,
      autoRouteApplicants: before.autoRouteApplicants,
      allowShiftDrop: before.allowShiftDrop,
    },
    after: {
      name: dept.name,
      isActive: dept.isActive,
      idealHeadcount: dept.idealHeadcount,
      patientCapacityPerProvider: dept.patientCapacityPerProvider,
      requiresEpicDirector: dept.requiresEpicDirector,
      requiresEpicVolunteer: dept.requiresEpicVolunteer,
      autoRouteApplicants: dept.autoRouteApplicants,
      allowShiftDrop: dept.allowShiftDrop,
    },
  });
  return dept;
}

/** Replace the manager's full set of managed departments (no self, deduped, validated). */
export async function setDelegations(
  actorPersonId: string,
  managerId: string,
  managedIds: string[]
): Promise<void> {
  const manager = await prisma.department.findUnique({ where: { id: managerId } });
  if (!manager) throw new DepartmentNotFoundError(managerId);

  const unique = [...new Set(managedIds)].filter((mid) => mid !== managerId);
  if (unique.length > 0) {
    const found = await prisma.department.count({ where: { id: { in: unique } } });
    if (found !== unique.length) {
      throw new DepartmentValidationError("One or more selected departments do not exist.");
    }
  }

  const beforeRows = await prisma.departmentDelegation.findMany({
    where: { managerDepartmentId: managerId },
    select: { managedDepartmentId: true },
  });

  const ops: Prisma.PrismaPromise<unknown>[] = [
    prisma.departmentDelegation.deleteMany({ where: { managerDepartmentId: managerId } }),
  ];
  if (unique.length > 0) {
    ops.push(
      prisma.departmentDelegation.createMany({
        data: unique.map((managedDepartmentId) => ({ managerDepartmentId: managerId, managedDepartmentId })),
      })
    );
  }
  await prisma.$transaction(ops);

  await recordAudit({
    actorPersonId,
    action: "department.set_delegations",
    entityType: "Department",
    entityId: managerId,
    before: { managed: beforeRows.map((r) => r.managedDepartmentId).sort() },
    after: { managed: [...unique].sort() },
  });
}
