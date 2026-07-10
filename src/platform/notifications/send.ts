import type { Prisma, PrismaClient, TeamsMessage } from "@prisma/client";
import { prisma } from "@/platform/db";
import { queueEmail } from "@/platform/email/send";
import { resolveTeamsTransport, type TeamsTransport } from "./teams-transport";
import { createEnqueueFlusher } from "@/platform/flush-on-enqueue";

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
/** A per-row send claim older than this is treated as abandoned (crashed worker)
 *  and may be reclaimed by another drain. Mirrors EmailLog's STALE_LOCK_MS. */
const STALE_LOCK_MS = 5 * 60 * 1000;

const teamsFlusher = createEnqueueFlusher(async () => {
  const transport = await resolveTeamsTransport();
  await drainTeamsQueue(transport);
});

/** Run the Teams drain now, coalescing overlapping calls. Exposed for the cron
 *  route and tests; delivery is normally triggered via queueTeamsMessage. */
export const flushTeamsQueue = teamsFlusher.flushNow;

/** Append a Teams message job, mirroring queueEmail (any Db handle). */
export async function queueTeamsMessage(db: Db, input: QueueTeamsInput): Promise<TeamsMessage> {
  const row = await db.teamsMessage.create({
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
  // Deliver on enqueue: after the response commits, drain so the DM goes out in
  // ~1s instead of waiting for the safety-net cron. No-ops outside a request scope.
  teamsFlusher.schedule();
  return row;
}

/**
 * Drain the QUEUED Teams message backlog, oldest-first. On success: SENT +
 * sentAt, caching the chat id. On failure: increment attempts (requeue) until
 * TEAMS_MAX_ATTEMPTS. On permanent failure the stored email fallback is queued
 * and the row is marked FALLBACK (Teams abandoned, but email delivered it); if
 * no email fallback lands (no contactEmail) the row is marked FAILED --
 * undelivered by any channel, surfaced on the admin "Failed" health card.
 *
 * Each QUEUED row is attempted AT MOST ONCE per invocation, walked with keyset
 * pagination (createdAt,id) in batches of `batchSize`: a requeued row sits
 * behind the cursor and is not re-attempted until the next cron tick. This
 * mirrors drainEmailQueue and avoids the retry-budget collapse of issue #63
 * (the caller invokes this once, not in a `while (processed > 0)` loop).
 *
 * Concurrency: before sending, each row is claimed with an atomic
 * updateMany(status=QUEUED, lock free) -> lockedAt=now, so only one worker wins a
 * given row. The sole /api/cron/email route drains email then Teams back-to-back,
 * and the external scheduler does not skip overlapping runs, so two ticks can
 * reach this drain at once when a Teams backlog outlives the 60s interval; the
 * claim is what stops both from sending the same message. The claim is released
 * on completion; a lock left by a crashed worker is reclaimable after
 * STALE_LOCK_MS, preserving at-least-once delivery. Mirrors drainEmailQueue.
 */
export async function drainTeamsQueue(
  transport: TeamsTransport,
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
    const rows: TeamsMessage[] = await prisma.teamsMessage.findMany({
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
      const claim = await prisma.teamsMessage.updateMany({
        where: { id: row.id, status: "QUEUED", ...claimable },
        data: { lockedAt: claimedAt },
      });
      if (claim.count === 0) continue;

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
            ? { status: "LOGGED", chatId: result.chatId, lockedAt: null }
            : { status: "SENT", sentAt: new Date(), chatId: result.chatId, lockedAt: null },
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
          // FALLBACK iff the email actually lands (queued here, or already up
          // front for channel "both"): the notification was delivered, just not
          // via Teams. With no email fallback the message is undelivered by any
          // channel -> FAILED, which lights the admin "Failed" card and is
          // retryable from the dashboard.
          await prisma.teamsMessage.update({
            where: { id: row.id },
            // Persist that the fallback email has landed so a later admin retry
            // (retryTeamsMessage resets status to QUEUED but preserves this flag)
            // that also fails permanently does not queue the same email a second
            // time (#74 dedup must hold on the retry path, not just first send).
            data: { attempts, lastError, status: emailLands ? "FALLBACK" : "FAILED", emailAlreadyQueued: emailLands, lockedAt: null },
          });
        } else {
          await prisma.teamsMessage.update({
            where: { id: row.id },
            // Keep the claim (do NOT null lockedAt): a failed row stays locked so
            // its retry is gated by the STALE_LOCK_MS window, not by how often a
            // drain is triggered. Delivery now fires on enqueue, so an enqueue
            // burst during an outage must not re-attempt this row until the lock
            // goes stale (mirrors drainEmailQueue; issue #63).
            data: { attempts, lastError: message, status: "QUEUED", lockedAt: claimedAt },
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
