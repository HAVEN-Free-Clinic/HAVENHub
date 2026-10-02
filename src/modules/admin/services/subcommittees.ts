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

export type SubcommitteeRow = Subcommittee & {
  _count: { assignedApplications: number; memberships: number };
};

/** The editable sign-up settings, shared by create and update. */
export type SubcommitteeSignupInput = {
  description?: string | null;
  capacity?: number | null;
  signupOpen?: boolean;
};

function resolveSignup(input: SubcommitteeSignupInput) {
  const description = input.description?.trim() || null;
  if (input.capacity !== undefined && input.capacity !== null) {
    if (!Number.isInteger(input.capacity) || input.capacity < 1) {
      throw new SubcommitteeValidationError("Capacity must be a whole number of at least 1, or blank for no limit.");
    }
  }
  return {
    description,
    capacity: input.capacity ?? null,
    signupOpen: input.signupOpen ?? false,
  };
}

/**
 * Display order is a sort key stored as an Int. Resolve an incoming value to a
 * whole number, falling back when it is absent. Crafted form input can arrive as
 * NaN (e.g. Number("abc")), which nullish coalescing does not catch, so guard it
 * here and surface a friendly validation error instead of a Prisma 500.
 */
function resolveOrder(order: number | undefined, fallback: number): number {
  if (order === undefined) return fallback;
  if (!Number.isInteger(order)) {
    throw new SubcommitteeValidationError("Display order must be a whole number.");
  }
  return order;
}

/** All subcommittees, active first then by order then name, with usage counts. */
export async function listSubcommittees(): Promise<SubcommitteeRow[]> {
  return prisma.subcommittee.findMany({
    include: { _count: { select: { assignedApplications: true, memberships: true } } },
    orderBy: [{ isActive: "desc" }, { order: "asc" }, { name: "asc" }],
  });
}

export async function getSubcommittee(id: string): Promise<Subcommittee | null> {
  return prisma.subcommittee.findUnique({ where: { id } });
}

export async function createSubcommittee(
  actorPersonId: string,
  input: { name: string; isActive?: boolean; order?: number } & SubcommitteeSignupInput
): Promise<Subcommittee> {
  const name = input.name.trim();
  if (!name) throw new SubcommitteeValidationError("Name is required.");
  const order = resolveOrder(input.order, 0);
  const signup = resolveSignup(input);

  const sc = await prisma.subcommittee.create({
    data: { name, isActive: input.isActive ?? true, order, ...signup },
  });
  await recordAudit({
    actorPersonId,
    action: "subcommittee.create",
    entityType: "Subcommittee",
    entityId: sc.id,
    after: { name: sc.name, isActive: sc.isActive, order: sc.order, ...signup },
  });
  return sc;
}

export async function updateSubcommittee(
  actorPersonId: string,
  id: string,
  input: { name: string; isActive: boolean; order?: number } & SubcommitteeSignupInput
): Promise<Subcommittee> {
  const before = await prisma.subcommittee.findUnique({ where: { id } });
  if (!before) throw new SubcommitteeNotFoundError(id);
  const name = input.name.trim();
  if (!name) throw new SubcommitteeValidationError("Name is required.");
  const order = resolveOrder(input.order, before.order);
  const signup = resolveSignup(input);

  const sc = await prisma.subcommittee.update({
    where: { id },
    data: { name, isActive: input.isActive, order, ...signup },
  });
  await recordAudit({
    actorPersonId,
    action: "subcommittee.update",
    entityType: "Subcommittee",
    entityId: id,
    before: {
      name: before.name, isActive: before.isActive, order: before.order,
      description: before.description, capacity: before.capacity, signupOpen: before.signupOpen,
    },
    after: { name: sc.name, isActive: sc.isActive, order: sc.order, ...signup },
  });
  return sc;
}
