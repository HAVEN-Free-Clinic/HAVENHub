import type { Prisma, PrismaClient } from "@prisma/client";
import { prisma } from "@/platform/db";
import { log, errorAttrs } from "@/platform/logging";

/** Either the singleton client or a transaction client, so a caller mid-transaction can record on the same connection. */
type Db = PrismaClient | Prisma.TransactionClient;

export type AuditEntry = {
  actorPersonId?: string | null;
  action: string; // "entity.verb", e.g. "person.update", "auth.applicant_login"
  entityType: string;
  entityId?: string | null;
  before?: Prisma.InputJsonValue;
  after?: Prisma.InputJsonValue;
  ip?: string | null;
};

/**
 * Fire-and-forget durable audit. Never throws; logs failures to stderr instead.
 *
 * Pass `client` when recording from inside a caller's open transaction, so the
 * audit row commits or rolls back together with the row it describes instead
 * of persisting on a separate connection if the outer transaction aborts.
 */
export async function recordAudit(entry: AuditEntry, client: Db = prisma): Promise<void> {
  try {
    await client.auditLog.create({
      data: {
        actorPersonId: entry.actorPersonId ?? null,
        action: entry.action,
        entityType: entry.entityType,
        entityId: entry.entityId ?? null,
        before: entry.before,
        after: entry.after,
        ip: entry.ip ?? null,
      },
    });
  } catch (error) {
    log.error("[audit] failed to record entry", errorAttrs(error, { action: entry.action }));
  }
}
