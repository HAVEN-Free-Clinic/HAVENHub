import { prisma } from "@/platform/db";
import { personMirrorPayload } from "./mirror-map";

export type AirtableWriter = {
  patchRecord(baseId: string, tableId: string, recordId: string, fields: Record<string, unknown>): Promise<unknown>;
  createRecord(baseId: string, tableId: string, fields: Record<string, unknown>): Promise<{ id: string }>;
};

export type MirrorTarget = {
  enabled: boolean;
  baseId: string;
  peopleTableId: string;
};

const MAX_ATTEMPTS = 8;

/** Drain up to `batchSize` pending outbox rows. Returns how many were processed. */
export async function drainOutbox(
  writer: AirtableWriter,
  target: MirrorTarget,
  batchSize = 10
): Promise<number> {
  if (!target.enabled) return 0;

  const rows = await prisma.outbox.findMany({
    where: { status: "PENDING" },
    orderBy: { createdAt: "asc" },
    take: batchSize,
  });

  let processed = 0;
  for (const row of rows) {
    try {
      const person = await prisma.person.findUnique({ where: { id: row.entityId } });
      if (!person) {
        await prisma.outbox.update({
          where: { id: row.id },
          data: { status: "FAILED", lastError: "entity no longer exists", processedAt: new Date() },
        });
        continue;
      }
      const payload = personMirrorPayload(person);
      const mapping = await prisma.mirrorRecord.findUnique({
        where: {
          entityType_entityId_baseId: {
            entityType: "Person",
            entityId: person.id,
            baseId: target.baseId,
          },
        },
      });
      if (mapping) {
        await writer.patchRecord(target.baseId, target.peopleTableId, mapping.recordId, payload);
      } else {
        const created = await writer.createRecord(target.baseId, target.peopleTableId, payload);
        await prisma.mirrorRecord.create({
          data: { entityType: "Person", entityId: person.id, baseId: target.baseId, recordId: created.id },
        });
      }
      await prisma.outbox.update({
        where: { id: row.id },
        data: { status: "SENT", processedAt: new Date() },
      });
      processed++;
    } catch (error) {
      const attempts = row.attempts + 1;
      await prisma.outbox.update({
        where: { id: row.id },
        data: {
          attempts,
          lastError: error instanceof Error ? error.message.slice(0, 500) : String(error),
          status: attempts >= MAX_ATTEMPTS ? "FAILED" : "PENDING",
        },
      });
    }
  }
  return processed;
}
