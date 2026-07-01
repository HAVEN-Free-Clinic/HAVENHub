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
  const training = (await prisma.ehsTraining.create({
    data: {
      name,
      description: input.description ?? null,
      isActive: input.isActive ?? true,
      requiredForAll: input.requiredForAll ?? false,
      position: (max._max.position ?? -1) + 1,
    },
  })) as EhsTraining & { requiredForAll: boolean };
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
  const training = (await prisma.ehsTraining.update({
    where: { id },
    data: {
      name,
      description: input.description ?? null,
      isActive: input.isActive ?? true,
      requiredForAll: input.requiredForAll ?? false,
    },
  })) as EhsTraining & { requiredForAll: boolean };
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

/** Replace the full department assignment for a training transactionally. */
export async function setTrainingDepartments(
  trainingId: string,
  departmentIds: string[],
  actorId: string
): Promise<void> {
  const db = prisma as unknown as {
    ehsTrainingDepartment: {
      deleteMany: (args: { where: { trainingId: string } }) => Promise<unknown>;
      createMany: (args: {
        data: { trainingId: string; departmentId: string }[];
        skipDuplicates?: boolean;
      }) => Promise<unknown>;
    };
    $transaction: typeof prisma.$transaction;
  };
  await db.$transaction(async (tx) => {
    const txDb = tx as unknown as typeof db;
    await txDb.ehsTrainingDepartment.deleteMany({ where: { trainingId } });
    if (departmentIds.length > 0) {
      await txDb.ehsTrainingDepartment.createMany({
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
  const rows = (await prisma.ehsTraining.findMany({
    orderBy: { position: "asc" },
    include: { _count: { select: { departments: true } } },
  })) as Array<{
    id: string;
    name: string;
    isActive: boolean;
    requiredForAll: boolean;
    _count: { departments: number };
  }>;
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    isActive: r.isActive,
    requiredForAll: r.requiredForAll,
    departmentCount: r._count.departments,
  }));
}

export async function getTrainingForEdit(id: string) {
  return (await prisma.ehsTraining.findUnique({
    where: { id },
    include: { departments: { select: { departmentId: true } } },
  })) as
    | (EhsTraining & {
        requiredForAll: boolean;
        departments: { departmentId: string }[];
      })
    | null;
}
