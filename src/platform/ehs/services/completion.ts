import { prisma } from "@/platform/db";
import { recordAudit } from "@/platform/audit";
import { captureEvent } from "@/platform/posthog/capture";
import { activeTermGroup } from "@/platform/posthog/groups";

export async function markEhsComplete(
  personId: string,
  trainingId: string,
  actorId: string,
  completedAt?: Date | null
): Promise<void> {
  // Detect the not-complete -> complete transition so the analytics event fires
  // exactly once, not on every re-save or date correction.
  const existing = await prisma.ehsCompletion.findUnique({
    where: { personId_trainingId: { personId, trainingId } },
    select: { completedAt: true },
  });
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
  // Effective completion date after this write (create defaults to now).
  const effectiveCompletedAt =
    completedAt === undefined ? (existing?.completedAt ?? new Date()) : completedAt;
  if (!existing?.completedAt && effectiveCompletedAt != null) {
    await captureEvent({
      event: "ehs_training_completed",
      distinctId: personId,
      properties: { training_id: trainingId, completed_by: actorId },
      groups: await activeTermGroup(),
    });
  }
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
