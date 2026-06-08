import type { RecruitmentCycle, RecruitmentTrack } from "@prisma/client";
import { prisma } from "@/platform/db";
import { recordAudit } from "@/platform/audit";
import { isSectionVisible } from "../engine/visibility";

export class CyclePublishError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CyclePublishError";
  }
}

export type CreateCycleInput = {
  track: RecruitmentTrack;
  termId: string;
  title: string;
  publicSlug: string;
  departments: string[];
  acceptsRenewals: boolean;
  createdById: string;
};

/** Create a DRAFT cycle and seed the mandatory identity section/fields so the
 *  publish guard and the public form always have name + email. Two steps: the
 *  cycle+section first (so we have both ids), then the fields with cycleId set
 *  directly. FormField.cycleId is required, so it cannot be a nested create. */
export async function createCycle(input: CreateCycleInput): Promise<RecruitmentCycle> {
  const cycle = await prisma.$transaction(async (tx) => {
    const created = await tx.recruitmentCycle.create({
      data: {
        track: input.track,
        termId: input.termId,
        title: input.title,
        publicSlug: input.publicSlug,
        departments: input.departments,
        acceptsRenewals: input.acceptsRenewals,
        createdById: input.createdById,
        sections: { create: { title: "Your information", order: 0, appliesTo: "BOTH" } },
      },
      include: { sections: true },
    });
    const identity = created.sections[0];
    await tx.formField.createMany({
      data: [
        { sectionId: identity.id, cycleId: created.id, key: "first_name", label: "First name", type: "SHORT_TEXT", required: true, order: 0 },
        { sectionId: identity.id, cycleId: created.id, key: "last_name", label: "Last name", type: "SHORT_TEXT", required: true, order: 1 },
        { sectionId: identity.id, cycleId: created.id, key: "email", label: "Yale email", type: "EMAIL", required: true, order: 2 },
      ],
    });
    return created;
  });

  await recordAudit({ actorPersonId: input.createdById, action: "recruitment.cycle_create", entityType: "RecruitmentCycle", entityId: cycle.id });
  return cycle;
}

export async function getCycle(id: string) {
  return prisma.recruitmentCycle.findUnique({
    where: { id },
    include: { sections: { include: { fields: { orderBy: { order: "asc" } } }, orderBy: { order: "asc" } } },
  });
}

/** A cycle with its full form definition (sections -> fields), as returned by getCycle. */
export type CycleWithForm = NonNullable<Awaited<ReturnType<typeof getCycle>>>;

export async function listCycles(): Promise<RecruitmentCycle[]> {
  return prisma.recruitmentCycle.findMany({
    where: { status: { not: "ARCHIVED" } },
    orderBy: { createdAt: "desc" },
  });
}

export async function publishCycle(id: string, actorId: string): Promise<RecruitmentCycle> {
  const cycle = await getCycle(id);
  if (!cycle) throw new CyclePublishError("Cycle not found.");
  if (cycle.status !== "DRAFT") throw new CyclePublishError("Only a DRAFT cycle can be published.");

  const allFields = cycle.sections.flatMap((s) => s.fields);
  const keys = new Set(allFields.map((f) => f.key));
  if (!keys.has("first_name") || !keys.has("last_name") || !keys.has("email")) {
    throw new CyclePublishError("Identity fields (first name, last name, email) are required before publishing.");
  }

  const hasDeptSupplement = cycle.sections.some((s) => s.departmentCode !== null);
  const deptChoiceCount = allFields.filter((f) => f.type === "DEPARTMENT_CHOICE").length;
  if (hasDeptSupplement && deptChoiceCount !== 1) {
    throw new CyclePublishError("A cycle with department supplements needs exactly one department-choice field.");
  }

  if (cycle.acceptsRenewals) {
    const sectionInputs = cycle.sections.map((s) => ({ id: s.id, appliesTo: s.appliesTo, departmentCode: s.departmentCode }));
    const newVisible = sectionInputs.some((s) => isSectionVisible(s, { applicantType: "NEW", selectedDepartmentCodes: cycle.departments }));
    const renewalVisible = sectionInputs.some((s) => isSectionVisible(s, { applicantType: "RENEWAL", selectedDepartmentCodes: cycle.departments }));
    if (!newVisible || !renewalVisible) {
      throw new CyclePublishError("A renewals cycle must have at least one section visible to each applicant type.");
    }
  }

  const updated = await prisma.recruitmentCycle.update({ where: { id }, data: { status: "OPEN" } });
  await recordAudit({ actorPersonId: actorId, action: "recruitment.cycle_publish", entityType: "RecruitmentCycle", entityId: id });
  return updated;
}

export async function closeCycle(id: string, actorId: string): Promise<RecruitmentCycle> {
  const cycle = await prisma.recruitmentCycle.findUnique({ where: { id } });
  if (!cycle) throw new CyclePublishError("Cycle not found.");
  if (cycle.status !== "OPEN") throw new CyclePublishError("Only an OPEN cycle can be closed.");
  const updated = await prisma.recruitmentCycle.update({ where: { id }, data: { status: "CLOSED" } });
  await recordAudit({ actorPersonId: actorId, action: "recruitment.cycle_close", entityType: "RecruitmentCycle", entityId: id });
  return updated;
}

export async function setAcceptsRenewals(id: string, value: boolean, actorId: string): Promise<RecruitmentCycle> {
  const cycle = await prisma.recruitmentCycle.findUnique({ where: { id } });
  if (!cycle) throw new CyclePublishError("Cycle not found.");
  if (cycle.status !== "DRAFT" && cycle.status !== "OPEN") throw new CyclePublishError("Renewals can only be changed on a draft or open cycle.");
  const updated = await prisma.recruitmentCycle.update({ where: { id }, data: { acceptsRenewals: value } });
  await recordAudit({ actorPersonId: actorId, action: "recruitment.cycle_set_renewals", entityType: "RecruitmentCycle", entityId: id, after: { acceptsRenewals: value } });
  return updated;
}
