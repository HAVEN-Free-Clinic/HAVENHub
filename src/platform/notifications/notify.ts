// src/platform/notifications/notify.ts
import type { Prisma, PrismaClient } from "@prisma/client";
import { queueEmail } from "@/platform/email/send";
import { resolveChannel } from "./channel";
import { createNotification } from "./inbox";
import { resolveTeamsUser, type ResolveIdentityDeps } from "./identity";
import { renderTeamsBody } from "./render";
import { queueTeamsMessage } from "./send";

type Db = PrismaClient | Prisma.TransactionClient;

export type NotifyPerson = {
  id: string;
  entraObjectId: string | null;
  contactEmail: string | null;
};

export type NotifyInput = {
  /** Notification type key (must be in the notification registry). */
  type: string;
  person: NotifyPerson;
  /** Email form (rendered subject/html), used for email delivery and Teams fallback. */
  email: { subject: string; html: string };
  /** Short Teams form. */
  teams: { title: string; summary: string; link?: string | null };
  triggeredById?: string | null;
};

/**
 * Unified notification dispatcher. Resolves the type's channel from settings and
 * queues to email and/or the Teams outbox accordingly. When channel is "teams"
 * but the recipient has no resolvable Teams identity, falls back to email at
 * queue time so the message still lands. Queues happen on the provided Db handle
 * (so it joins any surrounding transaction), exactly like queueEmail.
 */
export async function notify(
  db: Db,
  input: NotifyInput,
  deps: ResolveIdentityDeps = {}
): Promise<void> {
  const channel = await resolveChannel(input.type);
  const wantsEmail = channel === "email" || channel === "both";
  const wantsTeams = channel === "teams" || channel === "both";

  const queueTheEmail = async () => {
    if (!input.person.contactEmail) return;
    await queueEmail(db, {
      to: input.person.contactEmail,
      subject: input.email.subject,
      html: input.email.html,
      template: input.type,
      personId: input.person.id,
      triggeredById: input.triggeredById ?? null,
    });
  };

  if (wantsEmail) {
    await queueTheEmail();
  }

  if (wantsTeams) {
    const teamsUserId = await resolveTeamsUser(input.person, deps);
    if (teamsUserId) {
      await queueTeamsMessage(db, {
        personId: input.person.id,
        type: input.type,
        title: input.teams.title,
        summary: input.teams.summary,
        link: input.teams.link ?? null,
        bodyHtml: renderTeamsBody(input.teams),
        fallbackSubject: input.email.subject,
        fallbackHtml: input.email.html,
      });
    } else if (channel === "teams") {
      // No Teams identity and email was not already queued above: fall back now.
      await queueTheEmail();
    }
  }

  // In-app inbox: recorded after primary delivery so that a failed insert does
  // not short-circuit email or Teams routing. Always unconditional.
  await createNotification(db, {
    personId: input.person.id,
    type: input.type,
    title: input.teams.title,
    body: input.teams.summary,
    link: input.teams.link ?? null,
  });
}
