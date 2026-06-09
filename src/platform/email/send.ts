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
 * (PrismaClient or TransactionClient), exactly like enqueueMirror in outbox.ts.
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
 * Drain up to 25 QUEUED email rows, oldest-first. For each row, delegates to
 * transport.send(); on success stamps SENT + sentAt; on failure increments
 * attempts and sets lastError. When attempts reaches MAX_ATTEMPTS the row
 * becomes FAILED (same retry policy as drainOutbox in mirror.ts).
 *
 * Returns the number of rows attempted this pass, whether they succeeded or
 * not. The worker loops until this returns 0.
 *
 * Single-worker deployment assumed: no SELECT FOR UPDATE SKIP LOCKED, so two
 * concurrent drains would double-send. Same assumption as the mirror outbox
 * drain in mirror.ts.
 */
export async function drainEmailQueue(transport: EmailTransport): Promise<number> {
  const rows = await prisma.emailLog.findMany({
    where: { status: "QUEUED" },
    orderBy: { createdAt: "asc" },
    take: 25,
  });

  let processed = 0;
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
  return processed;
}
