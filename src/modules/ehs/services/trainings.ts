import type { EhsTraining } from "@prisma/client";
import { prisma } from "@/platform/db";
import { recordAudit } from "@/platform/audit";
import { EhsValidationError } from "./errors";

export type EhsTrainingInput = {
  name: string;
  description?: string | null;
  isActive?: boolean;
  requiredForAll?: boolean;
};

function normalizeName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length === 0) throw new EhsValidationError("Training name is required.");
  return trimmed;
}

export async function createTraining(
  input: EhsTrainingInput,
  actorId: string
): Promise<EhsTraining> {
  const name = normalizeName(input.name);
  const max = await prisma.ehsTraining.aggregate({ _max: { position: true } });
  const training = await prisma.ehsTraining.create({
    data: {
      name,
      description: input.description ?? null,
      isActive: input.isActive ?? true,
      requiredForAll: input.requiredForAll ?? false,
      position: (max._max.position ?? -1) + 1,
    },
  });
  await recordAudit({
    actorPersonId: actorId,
    action: "ehs.training_create",
    entityType: "EhsTraining",
    entityId: training.id,
    after: { name: training.name, requiredForAll: training.requiredForAll },
  });
  return training;
}

export async function updateTraining(
  id: string,
  input: EhsTrainingInput,
  actorId: string
): Promise<EhsTraining> {
  const name = normalizeName(input.name);
  const training = await prisma.ehsTraining.update({
    where: { id },
    data: {
      name,
      description: input.description ?? null,
      isActive: input.isActive ?? true,
      requiredForAll: input.requiredForAll ?? false,
    },
  });
  await recordAudit({
    actorPersonId: actorId,
    action: "ehs.training_update",
    entityType: "EhsTraining",
    entityId: training.id,
    after: {
      name: training.name,
      isActive: training.isActive,
      requiredForAll: training.requiredForAll,
    },
  });
  return training;
}

export async function setTrainingDepartments(
  trainingId: string,
  departmentIds: string[],
  actorId: string
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.ehsTrainingDepartment.deleteMany({ where: { trainingId } });
    if (departmentIds.length > 0) {
      await tx.ehsTrainingDepartment.createMany({
        data: departmentIds.map((departmentId) => ({ trainingId, departmentId })),
        skipDuplicates: true,
      });
    }
  });
  await recordAudit({
    actorPersonId: actorId,
    action: "ehs.training_set_departments",
    entityType: "EhsTraining",
    entityId: trainingId,
    after: { departmentIds },
  });
}

export type EhsTrainingListRow = {
  id: string;
  name: string;
  isActive: boolean;
  requiredForAll: boolean;
  departmentCount: number;
};

export async function listTrainings(): Promise<EhsTrainingListRow[]> {
  const rows = await prisma.ehsTraining.findMany({
    orderBy: { position: "asc" },
    include: { _count: { select: { departments: true } } },
  });
  return rows.map((r: { id: string; name: string; isActive: boolean; requiredForAll: boolean; _count: { departments: number } }) => ({
    id: r.id,
    name: r.name,
    isActive: r.isActive,
    requiredForAll: r.requiredForAll,
    departmentCount: r._count.departments,
  }));
}

export async function getTrainingForEdit(id: string) {
  return prisma.ehsTraining.findUnique({
    where: { id },
    include: { departments: { select: { departmentId: true } } },
  });
}
