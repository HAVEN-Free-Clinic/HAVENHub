// src/platform/notifications/send.ts
import type { Prisma, PrismaClient, TeamsMessage } from "@prisma/client";
import { prisma } from "@/platform/db";
import { queueEmail } from "@/platform/email/send";
import type { TeamsTransport } from "./teams-transport";

type Db = PrismaClient | Prisma.TransactionClient;

export type QueueTeamsInput = {
  personId: string;
  type: string;
  title: string;
  summary: string;
  link?: string | null;
  bodyHtml: string;
  fallbackSubject: string;
  fallbackHtml: string;
  /** True when the caller already queued this email up front (channel "both"),
   *  so the permanent-failure fallback must skip it rather than double-send. */
  emailAlreadyQueued?: boolean;
};

export const TEAMS_MAX_ATTEMPTS = 8;

/** Append a Teams message job, mirroring queueEmail (any Db handle). */
export async function queueTeamsMessage(db: Db, input: QueueTeamsInput): Promise<TeamsMessage> {
  return db.teamsMessage.create({
    data: {
      personId: input.personId,
      type: input.type,
      title: input.title,
      summary: input.summary,
      link: input.link ?? null,
      bodyHtml: input.bodyHtml,
      fallbackSubject: input.fallbackSubject,
      fallbackHtml: input.fallbackHtml,
      emailAlreadyQueued: input.emailAlreadyQueued ?? false,
    },
  });
}

/**
 * Drain the QUEUED Teams message backlog, oldest-first. On success: SENT +
 * sentAt, caching the chat id. On failure: increment attempts (requeue) until
 * TEAMS_MAX_ATTEMPTS, then queue the stored email fallback and mark FALLBACK.
 *
 * Each QUEUED row is attempted AT MOST ONCE per invocation, walked with keyset
 * pagination (createdAt,id) in batches of `batchSize`: a requeued row sits
 * behind the cursor and is not re-attempted until the next cron tick. This
 * mirrors drainEmailQueue and avoids the retry-budget collapse of issue #63
 * (the caller invokes this once, not in a `while (processed > 0)` loop).
 *
 * Single-worker assumption (no SKIP LOCKED), same as drainEmailQueue.
 */
export async function drainTeamsQueue(
  transport: TeamsTransport,
  batchSize = 25
): Promise<number> {
  let processed = 0;
  let cursor: { createdAt: Date; id: string } | null = null;

  for (;;) {
    // Annotate the result so the cursor (read below from the last row) does not
    // create a circular type-inference dependency with `rows`.
    const rows: TeamsMessage[] = await prisma.teamsMessage.findMany({
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
        const person = await prisma.person.findUnique({
          where: { id: row.personId },
          select: { entraObjectId: true, contactEmail: true },
        });
        const userId = person?.entraObjectId ?? null;
        if (!userId) throw new Error("recipient has no Teams identity");

        const result = await transport.send({
          recipientUserId: userId,
          chatId: row.chatId,
          bodyHtml: row.bodyHtml,
        });
        // The log transport records but never actually sends; mark such rows
        // LOGGED (not SENT) so the monitor never implies real delivery, and leave
        // sentAt null since nothing was delivered.
        await prisma.teamsMessage.update({
          where: { id: row.id },
          data: result.logged
            ? { status: "LOGGED", chatId: result.chatId }
            : { status: "SENT", sentAt: new Date(), chatId: result.chatId },
        });
      } catch (error) {
        const attempts = row.attempts + 1;
        const message = error instanceof Error ? error.message.slice(0, 500) : String(error);
        if (attempts >= TEAMS_MAX_ATTEMPTS) {
          // Permanent failure: degrade to email so the notification still lands
          // -- UNLESS notify() already queued this email up front (channel
          // "both", #74), in which case re-queueing here would double-send it.
          let emailLands = row.emailAlreadyQueued;
          if (!row.emailAlreadyQueued) {
            const person = await prisma.person.findUnique({
              where: { id: row.personId },
              select: { contactEmail: true },
            });
            if (person?.contactEmail) {
              await queueEmail(prisma, {
                to: person.contactEmail,
                subject: row.fallbackSubject,
                html: row.fallbackHtml,
                template: row.type,
                personId: row.personId,
              });
              emailLands = true;
            }
          }
          const lastError = emailLands
            ? message
            : `${message} | no contactEmail: email fallback skipped, message not delivered`.slice(0, 500);
          await prisma.teamsMessage.update({
            where: { id: row.id },
            data: { attempts, lastError, status: "FALLBACK" },
          });
        } else {
          await prisma.teamsMessage.update({
            where: { id: row.id },
            data: { attempts, lastError: message, status: "QUEUED" },
          });
        }
      }
      processed += 1;
    }

    // Advance past the last row processed. A requeued row is now behind the
    // cursor and will not be re-attempted this invocation.
    const last = rows[rows.length - 1];
    cursor = { createdAt: last.createdAt, id: last.id };
  }

  return processed;
}
