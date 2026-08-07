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
 * Durable audit. On the default (singleton) path this is fire-and-forget: it
 * never throws, and logs failures to stderr instead.
 *
 * Pass `client` when recording from inside a caller's open transaction, so the
 * audit row commits or rolls back together with the row it describes instead
 * of persisting on a separate connection if the outer transaction aborts. On
 * THAT path a failed insert is rethrown instead of swallowed -- see the catch
 * block below for why.
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
    // Swallowing is correct ONLY on the singleton path. When `client` is a
    // transaction client, Postgres has already marked that connection's
    // transaction aborted at the wire level the instant the insert failed.
    // Catching and returning normally does not undo that: Prisma never learns
    // the transaction is dead, so either (a) any later statement in the same
    // transaction fails with a confusing "current transaction is aborted"
    // error, or worse, (b) if this was the last statement before commit,
    // Postgres silently turns the COMMIT into a ROLLBACK and raises nothing --
    // the caller believes the whole operation succeeded while nothing was
    // persisted. So inside a transaction we rethrow: let the caller's
    // transaction roll back honestly and visibly instead of reporting success
    // on top of a lie. Only the no-client-passed (or explicitly the singleton)
    // case keeps the original fire-and-forget contract, since an audit
    // failure there is unrelated to any transaction and must not break the
    // caller's operation.
    if (client !== prisma) throw error;
    log.error("[audit] failed to record entry", errorAttrs(error, { action: entry.action }));
  }
}
