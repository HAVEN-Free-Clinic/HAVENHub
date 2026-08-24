import type { EhsTraining } from "@prisma/client";
import { prisma, isUniqueConstraintError, isForeignKeyConstraintError } from "@/platform/db";
import { recordAudit } from "@/platform/audit";
import { EhsValidationError } from "./errors";

export type EhsTrainingInput = {
  name: string;
  description?: string | null;
  isActive?: boolean;
  requiredForAll?: boolean;
  /** Where the member completes it. Null/empty means Workday Learning. */
  completionUrl?: string | null;
};

function normalizeName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length === 0) throw new EhsValidationError("Training name is required.");
  return trimmed;
}

/** Empty clears the link (back to the Workday default); anything kept must be a
 *  real http(s) URL, since it is rendered straight into a member-facing anchor. */
function normalizeCompletionUrl(url: string | null | undefined): string | null {
  const trimmed = url?.trim();
  if (!trimmed) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new EhsValidationError("Completion link must be a full URL starting with https://.");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new EhsValidationError("Completion link must be a full URL starting with https://.");
  }
  return trimmed;
}

export async function createTraining(
  input: EhsTrainingInput,
  actorId: string
): Promise<EhsTraining> {
  const name = normalizeName(input.name);
  const completionUrl = normalizeCompletionUrl(input.completionUrl);
  const max = await prisma.ehsTraining.aggregate({ _max: { position: true } });
  let training: EhsTraining & { requiredForAll: boolean };
  try {
    training = (await prisma.ehsTraining.create({
      data: {
        name,
        description: input.description ?? null,
        isActive: input.isActive ?? true,
        requiredForAll: input.requiredForAll ?? false,
        completionUrl,
        position: (max._max.position ?? -1) + 1,
      },
    })) as EhsTraining & { requiredForAll: boolean };
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      throw new EhsValidationError("A training with that name already exists.");
    }
    throw err;
  }
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
  const completionUrl = normalizeCompletionUrl(input.completionUrl);
  let training: EhsTraining & { requiredForAll: boolean };
  try {
    training = (await prisma.ehsTraining.update({
      where: { id },
      data: {
        name,
        description: input.description ?? null,
        isActive: input.isActive ?? true,
        requiredForAll: input.requiredForAll ?? false,
        completionUrl,
      },
    })) as EhsTraining & { requiredForAll: boolean };
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      throw new EhsValidationError("A training with that name already exists.");
    }
    throw err;
  }
  await recordAudit({
    actorPersonId: actorId,
    action: "ehs.training_update",
    entityType: "EhsTraining",
    entityId: training.id,
    after: {
      name: training.name,
      isActive: training.isActive,
      requiredForAll: training.requiredForAll,
      completionUrl,
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
  try {
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
  } catch (err) {
    if (isForeignKeyConstraintError(err)) {
      throw new EhsValidationError("One or more selected departments no longer exist.");
    }
    throw err;
  }
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
