import type { Prisma, PrismaClient, EmailLog } from "@prisma/client";
import { prisma } from "@/platform/db";
import type { EmailTransport } from "./transport";
import { resolveSenderForTemplate } from "./sender-rules";

type Db = PrismaClient | Prisma.TransactionClient;

export type QueueEmailInput = {
  to: string;
  subject: string;
  html: string;
  template: string;
  personId?: string | null;
  triggeredById?: string | null;
  campaignRunId?: string | null;
};

const MAX_ATTEMPTS = 8;
/** A per-row send claim older than this is treated as abandoned (crashed worker)
 *  and may be reclaimed by another drain. Bounds the worst-case redelivery delay. */
const STALE_LOCK_MS = 5 * 60 * 1000;

/**
 * Append an email send job in the SAME transaction as the domain write, so a
 * rolled-back mutation never leaks a phantom send. Callers pass any Db handle
 * (PrismaClient or TransactionClient) so the job commits atomically with it.
 */
export async function queueEmail(db: Db, input: QueueEmailInput): Promise<EmailLog> {
  const sender = await resolveSenderForTemplate(input.template);
  return db.emailLog.create({
    data: {
      toEmail: input.to,
      subject: input.subject,
      html: input.html,
      template: input.template,
      personId: input.personId ?? null,
      triggeredById: input.triggeredById ?? null,
      campaignRunId: input.campaignRunId ?? null,
      fromEmail: sender?.fromEmail ?? null,
      fromName: sender?.fromName ?? null,
    },
  });
}

/**
 * Drain the QUEUED email backlog, oldest-first. For each row, delegates to
 * transport.send(); on success stamps SENT + sentAt; on failure increments
 * attempts and sets lastError. When attempts reaches MAX_ATTEMPTS the row
 * becomes FAILED.
 *
 * Each QUEUED row is attempted AT MOST ONCE per invocation. The backlog is
 * walked with keyset pagination (createdAt,id) in batches of `batchSize`: a row
 * that fails its send stays QUEUED but sits behind the cursor, so it is not
 * re-fetched until the NEXT cron tick. This is what spreads the 8 retries
 * across minute-ticks. The old implementation fetched only the oldest batch and
 * relied on the caller looping `while (processed > 0)`; because a failed row
 * stayed QUEUED and `processed` counted failures, a whole-tick transport outage
 * re-attempted the same rows pass after pass until all 8 retries burned and the
 * queue mass-FAILED in seconds (issue #63). The caller now invokes this once.
 *
 * Returns the number of rows this invocation claimed and attempted.
 *
 * Concurrency: before sending, each row is claimed with an atomic
 * updateMany(status=QUEUED, lock free) -> lockedAt=now, so only one worker wins a
 * given row. Two overlapping drains (a backlog that outlives the 60s cron
 * interval, plus an external scheduler that does not skip overlapping runs)
 * therefore cannot both send the same row. The claim is released on success or
 * permanent failure (a transient failure keeps it to gate the retry); a lock left
 * by a crashed worker is reclaimable after STALE_LOCK_MS, which preserves
 * at-least-once delivery (a crash between claim and send re-sends once the lock
 * goes stale).
 */
export async function drainEmailQueue(
  transport: EmailTransport,
  batchSize = 25
): Promise<number> {
  let processed = 0;
  let cursor: { createdAt: Date; id: string } | null = null;
  const claimedAt = new Date();
  const staleBefore = new Date(claimedAt.getTime() - STALE_LOCK_MS);
  // A row is claimable when it is unlocked, or its lock is stale (crashed worker).
  const claimable = { OR: [{ lockedAt: null }, { lockedAt: { lt: staleBefore } }] };

  for (;;) {
    // Annotate the result so the cursor (read below from the last row) does not
    // create a circular type-inference dependency with `rows`.
    const rows: EmailLog[] = await prisma.emailLog.findMany({
      where: {
        status: "QUEUED",
        ...claimable,
        ...(cursor
          ? {
              AND: [
                {
                  OR: [
                    { createdAt: { gt: cursor.createdAt } },
                    { createdAt: cursor.createdAt, id: { gt: cursor.id } },
                  ],
                },
              ],
            }
          : {}),
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: batchSize,
    });
    if (rows.length === 0) break;

    for (const row of rows) {
      // Atomic claim. If a concurrent drain already took this row (or it is no
      // longer QUEUED) the count is 0 and we skip it without sending.
      const claim = await prisma.emailLog.updateMany({
        where: { id: row.id, status: "QUEUED", ...claimable },
        data: { lockedAt: claimedAt },
      });
      if (claim.count === 0) continue;

      try {
        await transport.send({
          to: row.toEmail,
          subject: row.subject,
          html: row.html,
          from: row.fromEmail ?? undefined,
          fromName: row.fromName ?? undefined,
        });
        // At-least-once: a crash between send and this update re-sends the row
        // once its claim goes stale.
        await prisma.emailLog.update({
          where: { id: row.id },
          data: { status: "SENT", sentAt: new Date(), lockedAt: null },
        });
      } catch (error) {
        const attempts = row.attempts + 1;
        const failed = attempts >= MAX_ATTEMPTS;
        await prisma.emailLog.update({
          where: { id: row.id },
          data: {
            attempts,
            lastError: error instanceof Error ? error.message.slice(0, 500) : String(error),
            status: failed ? "FAILED" : "QUEUED",
            // Transient failure: keep the claim (lockedAt stays set) so the retry
            // is gated by the STALE_LOCK_MS window, not by how often a drain is
            // triggered. Delivery now fires on enqueue, so an enqueue burst during
            // an outage must not re-attempt this row until the lock goes stale, or
            // it would burn all 8 retries in seconds (issue #63).
            // Permanent failure: release the lock so an admin Retry / Retry-all
            // (FAILED -> QUEUED) is immediately claimable instead of stuck behind a
            // stale lock for up to STALE_LOCK_MS.
            lockedAt: failed ? null : claimedAt,
          },
        });
      }
      processed += 1;
    }

    // Advance past the last row fetched. A row that failed and stayed QUEUED is
    // now behind the cursor and will not be re-attempted this invocation.
    const last = rows[rows.length - 1];
    cursor = { createdAt: last.createdAt, id: last.id };
  }

  return processed;
}
