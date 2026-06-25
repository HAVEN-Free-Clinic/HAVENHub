/**
 * Subcommittees service: create, update (name/active/order), list. Mirrors
 * departments.ts -- typed errors, actor-scoped mutations that audit. Permission
 * checks are the caller's job. Removal is soft (isActive=false) so historical
 * application rankings always resolve to a name.
 */
import type { Subcommittee } from "@prisma/client";
import { prisma } from "@/platform/db";
import { recordAudit } from "@/platform/audit";

export class SubcommitteeNotFoundError extends Error {
  constructor(public id: string) {
    super(`Subcommittee ${id} not found.`);
    this.name = "SubcommitteeNotFoundError";
  }
}
export class SubcommitteeValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SubcommitteeValidationError";
  }
}

export type SubcommitteeRow = Subcommittee & { _count: { assignedApplications: number } };

/** All subcommittees, active first then by order then name, with usage counts. */
export async function listSubcommittees(): Promise<SubcommitteeRow[]> {
  return prisma.subcommittee.findMany({
    include: { _count: { select: { assignedApplications: true } } },
    orderBy: [{ isActive: "desc" }, { order: "asc" }, { name: "asc" }],
  });
}

export async function getSubcommittee(id: string): Promise<Subcommittee | null> {
  return prisma.subcommittee.findUnique({ where: { id } });
}

export async function createSubcommittee(
  actorPersonId: string,
  input: { name: string; isActive?: boolean; order?: number }
): Promise<Subcommittee> {
  const name = input.name.trim();
  if (!name) throw new SubcommitteeValidationError("Name is required.");

  const sc = await prisma.subcommittee.create({
    data: { name, isActive: input.isActive ?? true, order: input.order ?? 0 },
  });
  await recordAudit({
    actorPersonId,
    action: "subcommittee.create",
    entityType: "Subcommittee",
    entityId: sc.id,
    after: { name: sc.name, isActive: sc.isActive },
  });
  return sc;
}

export async function updateSubcommittee(
  actorPersonId: string,
  id: string,
  input: { name: string; isActive: boolean; order?: number }
): Promise<Subcommittee> {
  const before = await prisma.subcommittee.findUnique({ where: { id } });
  if (!before) throw new SubcommitteeNotFoundError(id);
  const name = input.name.trim();
  if (!name) throw new SubcommitteeValidationError("Name is required.");

  const sc = await prisma.subcommittee.update({
    where: { id },
    data: { name, isActive: input.isActive, order: input.order ?? before.order },
  });
  await recordAudit({
    actorPersonId,
    action: "subcommittee.update",
    entityType: "Subcommittee",
    entityId: id,
    before: { name: before.name, isActive: before.isActive, order: before.order },
    after: { name: sc.name, isActive: sc.isActive, order: sc.order },
  });
  return sc;
}
