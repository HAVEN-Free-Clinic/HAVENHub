import { prisma } from "@/platform/db";
import { recordAudit } from "@/platform/audit";

export async function setAddedToEhs(personId: string, value: boolean, actorId: string): Promise<void> {
  await prisma.person.update({ where: { id: personId }, data: { addedToEhs: value } });
  await recordAudit({
    actorPersonId: actorId,
    action: "ehs.added_to_ehs_set",
    entityType: "Person",
    entityId: personId,
    after: { addedToEhs: value },
  });
}
