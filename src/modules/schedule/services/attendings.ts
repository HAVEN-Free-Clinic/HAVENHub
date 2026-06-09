/**
 * RHD attending roster service.
 *
 * The readiness panel reads each attending's six procedure capabilities. This
 * service lets schedule managers maintain the roster. Mutations require the
 * actor to manage an RHD-family department (same scope as upsertRhdClinic).
 */

import type { RhdAttending } from "@prisma/client";
import { prisma } from "@/platform/db";
import { recordAudit } from "@/platform/audit";
import { manageableScheduleDepartmentIds, RHD_CODES } from "./builder";

export type CapabilityValue = "yes" | "no" | "unknown";
export const CAPABILITY_KEYS = ["iudIn", "iudOut", "nexplanon", "gac", "emb", "seesMale"] as const;
export type CapabilityKey = (typeof CAPABILITY_KEYS)[number];

export class AttendingForbiddenError extends Error {
  constructor(message = "Actor does not manage any RHD-family department.") {
    super(message);
    this.name = "AttendingForbiddenError";
  }
}

export class AttendingValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AttendingValidationError";
  }
}

async function assertRhdManager(actor: string): Promise<void> {
  const manageable = await manageableScheduleDepartmentIds(actor);
  const rhdDepts = await prisma.department.findMany({
    where: { code: { in: [...RHD_CODES] } },
    select: { id: true },
  });
  const rhdIds = new Set(rhdDepts.map((d) => d.id));
  if (!manageable.some((id) => rhdIds.has(id))) throw new AttendingForbiddenError();
}

function validCapability(v: unknown): CapabilityValue {
  if (v === "yes" || v === "no" || v === "unknown") return v;
  throw new AttendingValidationError(`Invalid capability value: ${String(v)}`);
}

export function listAttendings(): Promise<RhdAttending[]> {
  return prisma.rhdAttending.findMany({ orderBy: { scheduleName: "asc" } });
}

export function getAttending(id: string): Promise<RhdAttending | null> {
  return prisma.rhdAttending.findUnique({ where: { id } });
}

type CapabilityInput = Partial<Record<CapabilityKey, CapabilityValue>>;

export async function createAttending(
  actor: string,
  input: { scheduleName: string; fullName: string; capabilities?: CapabilityInput; notes?: string | null },
): Promise<RhdAttending> {
  await assertRhdManager(actor);
  const scheduleName = input.scheduleName.trim();
  const fullName = input.fullName.trim();
  if (!scheduleName) throw new AttendingValidationError("Schedule name is required.");
  if (!fullName) throw new AttendingValidationError("Full name is required.");

  const caps: Record<CapabilityKey, CapabilityValue> = {
    iudIn: "unknown", iudOut: "unknown", nexplanon: "unknown", gac: "unknown", emb: "unknown", seesMale: "unknown",
  };
  for (const k of CAPABILITY_KEYS) {
    if (input.capabilities && k in input.capabilities) caps[k] = validCapability(input.capabilities[k]);
  }

  const existing = await prisma.rhdAttending.findUnique({ where: { scheduleName } });
  if (existing) throw new AttendingValidationError(`An attending named "${scheduleName}" already exists.`);

  const created = await prisma.rhdAttending.create({
    data: { scheduleName, fullName, ...caps, notes: input.notes ?? null },
  });
  await recordAudit({
    actorPersonId: actor,
    action: "schedule.attending_create",
    entityType: "RhdAttending",
    entityId: created.id,
    after: { scheduleName, fullName, ...caps },
  });
  return created;
}

export async function updateAttending(
  actor: string,
  id: string,
  patch: { scheduleName?: string; fullName?: string; capabilities?: CapabilityInput; notes?: string | null; isActive?: boolean },
): Promise<RhdAttending> {
  await assertRhdManager(actor);
  const existing = await prisma.rhdAttending.findUnique({ where: { id } });
  if (!existing) throw new AttendingValidationError("Attending not found.");

  const data: Record<string, unknown> = {};
  if (patch.scheduleName !== undefined) {
    const sn = patch.scheduleName.trim();
    if (!sn) throw new AttendingValidationError("Schedule name is required.");
    if (sn !== existing.scheduleName) {
      const dup = await prisma.rhdAttending.findUnique({ where: { scheduleName: sn } });
      if (dup) throw new AttendingValidationError(`An attending named "${sn}" already exists.`);
    }
    data.scheduleName = sn;
  }
  if (patch.fullName !== undefined) {
    const fn = patch.fullName.trim();
    if (!fn) throw new AttendingValidationError("Full name is required.");
    data.fullName = fn;
  }
  if (patch.capabilities) {
    for (const k of CAPABILITY_KEYS) {
      if (k in patch.capabilities) data[k] = validCapability(patch.capabilities[k]);
    }
  }
  if ("notes" in patch) data.notes = patch.notes ?? null;
  if (patch.isActive !== undefined) data.isActive = patch.isActive;

  const updated = await prisma.rhdAttending.update({ where: { id }, data });
  const auditShape = (r: typeof existing) => ({
    scheduleName: r.scheduleName,
    fullName: r.fullName,
    iudIn: r.iudIn,
    iudOut: r.iudOut,
    nexplanon: r.nexplanon,
    gac: r.gac,
    emb: r.emb,
    seesMale: r.seesMale,
    notes: r.notes,
    isActive: r.isActive,
  });
  await recordAudit({
    actorPersonId: actor,
    action: "schedule.attending_update",
    entityType: "RhdAttending",
    entityId: id,
    before: auditShape(existing),
    after: auditShape(updated),
  });
  return updated;
}

export async function setAttendingActive(actor: string, id: string, isActive: boolean): Promise<RhdAttending> {
  return updateAttending(actor, id, { isActive });
}
