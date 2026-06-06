import type { Prisma } from "@prisma/client";
import { prisma } from "@/platform/db";

export type AuditEntry = {
  actorPersonId?: string | null;
  action: string; // "entity.verb", e.g. "person.update", "auth.login_unmatched"
  entityType: string;
  entityId?: string | null;
  before?: Prisma.InputJsonValue;
  after?: Prisma.InputJsonValue;
  ip?: string | null;
};

/** Fire-and-forget durable audit. Never throws; logs failures to stderr instead. */
export async function recordAudit(entry: AuditEntry): Promise<void> {
  try {
    await prisma.auditLog.create({
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
    console.error("[audit] failed to record entry", entry.action, error);
  }
}
