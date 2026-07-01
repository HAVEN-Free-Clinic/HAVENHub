import { prisma } from "@/platform/db";
import { recordAudit } from "@/platform/audit";

export async function markEhsComplete(
  personId: string,
  trainingId: string,
  actorId: string,
  completedAt?: Date | null
): Promise<void> {
  await prisma.ehsCompletion.upsert({
    where: { personId_trainingId: { personId, trainingId } },
    create: {
      personId,
      trainingId,
      source: "MANUAL",
      markedById: actorId,
      completedAt: completedAt ?? new Date(),
    },
    update: {
      markedById: actorId,
      markedAt: new Date(),
      ...(completedAt !== undefined ? { completedAt } : {}),
    },
  });
  await recordAudit({
    actorPersonId: actorId,
    action: "ehs.completion_mark",
    entityType: "EhsCompletion",
    entityId: `${personId}:${trainingId}`,
    after: { personId, trainingId, completedAt: completedAt ?? null },
  });
}

export async function unmarkEhsComplete(
  personId: string,
  trainingId: string,
  actorId: string
): Promise<void> {
  await prisma.ehsCompletion.deleteMany({ where: { personId, trainingId } });
  await recordAudit({
    actorPersonId: actorId,
    action: "ehs.completion_unmark",
    entityType: "EhsCompletion",
    entityId: `${personId}:${trainingId}`,
    before: { personId, trainingId },
  });
}
