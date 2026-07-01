import type { EhsTraining } from "@prisma/client";
import { prisma } from "@/platform/db";
import { recordAudit } from "@/platform/audit";
import { EhsValidationError } from "./errors";

export type EhsTrainingInput = {
  name: string;
  description?: string | null;
  isActive?: boolean;
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
      position: (max._max.position ?? -1) + 1,
    },
  });
  await recordAudit({
    actorPersonId: actorId,
    action: "ehs.training_create",
    entityType: "EhsTraining",
    entityId: training.id,
    after: { name: training.name },
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
    },
  });
  await recordAudit({
    actorPersonId: actorId,
    action: "ehs.training_update",
    entityType: "EhsTraining",
    entityId: training.id,
    after: { name: training.name, isActive: training.isActive },
  });
  return training;
}

export type EhsTrainingListRow = {
  id: string;
  name: string;
  isActive: boolean;
};

export async function listTrainings(): Promise<EhsTrainingListRow[]> {
  const rows = (await prisma.ehsTraining.findMany({
    orderBy: { position: "asc" },
    select: { id: true, name: true, isActive: true },
  })) as Array<{ id: string; name: string; isActive: boolean }>;
  return rows.map((r) => ({ id: r.id, name: r.name, isActive: r.isActive }));
}

export async function getTrainingForEdit(id: string) {
  return prisma.ehsTraining.findUnique({ where: { id } });
}
