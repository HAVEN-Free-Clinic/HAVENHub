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
    },
  });
}

/**
 * Drain up to 25 QUEUED Teams messages, oldest-first. On success: SENT + sentAt,
 * caching the chat id. On failure: increment attempts (requeue) until
 * TEAMS_MAX_ATTEMPTS, then queue the stored email fallback and mark FALLBACK.
 *
 * Single-worker assumption (no SKIP LOCKED), same as drainEmailQueue.
 */
export async function drainTeamsQueue(transport: TeamsTransport): Promise<number> {
  const rows = await prisma.teamsMessage.findMany({
    where: { status: "QUEUED" },
    orderBy: { createdAt: "asc" },
    take: 25,
  });

  let processed = 0;
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
      await prisma.teamsMessage.update({
        where: { id: row.id },
        data: { status: "SENT", sentAt: new Date(), chatId: result.chatId },
      });
    } catch (error) {
      const attempts = row.attempts + 1;
      const message = error instanceof Error ? error.message.slice(0, 500) : String(error);
      if (attempts >= TEAMS_MAX_ATTEMPTS) {
        // Permanent failure: degrade to email so the notification still lands.
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
        }
        const lastError = person?.contactEmail
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
  return processed;
}
