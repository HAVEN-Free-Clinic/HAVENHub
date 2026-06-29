import type { Prisma, PrismaClient, EmailLog } from "@prisma/client";
import { prisma } from "@/platform/db";
import type { EmailTransport } from "./transport";

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

/**
 * Append an email send job in the SAME transaction as the domain write, so a
 * rolled-back mutation never leaks a phantom send. Callers pass any Db handle
 * (PrismaClient or TransactionClient) so the job commits atomically with it.
 */
export async function queueEmail(db: Db, input: QueueEmailInput): Promise<EmailLog> {
  return db.emailLog.create({
    data: {
      toEmail: input.to,
      subject: input.subject,
      html: input.html,
      template: input.template,
      personId: input.personId ?? null,
      triggeredById: input.triggeredById ?? null,
      campaignRunId: input.campaignRunId ?? null,
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
 * Returns the number of rows attempted this invocation (succeeded or not).
 *
 * Single-worker deployment assumed: no SELECT FOR UPDATE SKIP LOCKED, so two
 * concurrent drains would double-send.
 */
export async function drainEmailQueue(
  transport: EmailTransport,
  batchSize = 25
): Promise<number> {
  let processed = 0;
  let cursor: { createdAt: Date; id: string } | null = null;

  for (;;) {
    // Annotate the result so the cursor (read below from the last row) does not
    // create a circular type-inference dependency with `rows`.
    const rows: EmailLog[] = await prisma.emailLog.findMany({
      where: {
        status: "QUEUED",
        ...(cursor
          ? {
              OR: [
                { createdAt: { gt: cursor.createdAt } },
                { createdAt: cursor.createdAt, id: { gt: cursor.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: batchSize,
    });
    if (rows.length === 0) break;

    for (const row of rows) {
      try {
        await transport.send({ to: row.toEmail, subject: row.subject, html: row.html });
        // At-least-once: a crash between send and this update re-sends the row
        // on the next drain pass.
        await prisma.emailLog.update({
          where: { id: row.id },
          data: { status: "SENT", sentAt: new Date() },
        });
      } catch (error) {
        const attempts = row.attempts + 1;
        await prisma.emailLog.update({
          where: { id: row.id },
          data: {
            attempts,
            lastError: error instanceof Error ? error.message.slice(0, 500) : String(error),
            status: attempts >= MAX_ATTEMPTS ? "FAILED" : "QUEUED",
          },
        });
      }
      processed += 1;
    }

    // Advance past the last row processed. A row that failed and stayed QUEUED
    // is now behind the cursor and will not be re-attempted this invocation.
    const last = rows[rows.length - 1];
    cursor = { createdAt: last.createdAt, id: last.id };
  }

  return processed;
}
