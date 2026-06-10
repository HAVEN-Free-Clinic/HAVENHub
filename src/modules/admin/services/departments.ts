/**
 * Departments service: create, update (name/active/capacity), delegation editing.
 * Mirrors terms.ts -- typed errors, actor-scoped mutations that audit. Permission
 * checks are the caller's job. Code is immutable after creation; removal is soft
 * (isActive=false).
 */
import type { Department, Prisma } from "@prisma/client";
import { prisma } from "@/platform/db";
import { recordAudit } from "@/platform/audit";

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

/** All departments, active first then by code, with membership counts + managed ids. */
export async function listDepartments(): Promise<DepartmentRow[]> {
  return prisma.department.findMany({
    include: {
      _count: { select: { memberships: true } },
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

  const existing = await prisma.department.findFirst({
    where: { code: { equals: code, mode: "insensitive" } },
  });
  if (existing) throw new DepartmentConflictError(code);

  let dept: Department;
  try {
    dept = await prisma.department.create({
      data: { code, name, isActive: input.isActive ?? true, idealHeadcount, patientCapacityPerProvider },
    });
  } catch (err) {
    if (err != null && typeof err === "object" && "code" in err && (err as { code: string }).code === "P2002") {
      throw new DepartmentConflictError(code);
    }
    throw err;
  }

  await recordAudit({
    actorPersonId,
    action: "department.create",
    entityType: "Department",
    entityId: dept.id,
    after: { code: dept.code, name: dept.name, isActive: dept.isActive },
  });
  return dept;
}

export async function updateDepartment(
  actorPersonId: string,
  id: string,
  input: { name: string; isActive: boolean; idealHeadcount: number | null; patientCapacityPerProvider: number | null }
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

  const dept = await prisma.department.update({
    where: { id },
    data: { name, isActive: input.isActive, idealHeadcount, patientCapacityPerProvider },
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
    },
    after: {
      name: dept.name,
      isActive: dept.isActive,
      idealHeadcount: dept.idealHeadcount,
      patientCapacityPerProvider: dept.patientCapacityPerProvider,
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
