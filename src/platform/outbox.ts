import type { Prisma, PrismaClient } from "@prisma/client";
import { prisma } from "@/platform/db";

type Db = PrismaClient | Prisma.TransactionClient;

export type MirrorChange = {
  entityType: "Person" | "HipaaCertificate";
  entityId: string;
  changedFields: string[];
};

/**
 * Append a mirror job in the SAME transaction as the domain write, so a
 * rolled-back mutation never leaks into Airtable. Future module services call
 * this whenever they touch mirrored fields.
 */
export async function enqueueMirror(db: Db, change: MirrorChange): Promise<void> {
  await db.outbox.create({
    data: {
      entityType: change.entityType,
      entityId: change.entityId,
      operation: "upsert",
      changedFields: change.changedFields,
    },
  });
}

export async function outboxStats(): Promise<{ pending: number; failed: number }> {
  const [pending, failed] = await Promise.all([
    prisma.outbox.count({ where: { status: "PENDING" } }),
    prisma.outbox.count({ where: { status: "FAILED" } }),
  ]);
  return { pending, failed };
}
