/**
 * Issuing and reading a member's service credential.
 *
 * Issuance SNAPSHOTS the computed record (see service-record.ts). Nothing in the
 * app renders a live computation: the certificate PDF and the public credential
 * page both read this frozen JSON, which is what keeps them in agreement and
 * what stops a public URL from surfacing a record the member never published.
 */

import { randomBytes } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/platform/db";
import { recordAudit } from "@/platform/audit";
import { log, errorAttrs } from "@/platform/logging";
import {
  computeServiceRecord,
  type PrismaClientOrTx,
  type ServiceRecord,
} from "./service-record";

export type IssuedCredential = {
  id: string;
  record: ServiceRecord;
  publicToken: string | null;
  issuedAt: string;
  revokedAt: string | null;
};

function toIssued(row: {
  id: string;
  record: Prisma.JsonValue;
  publicToken: string | null;
  issuedAt: Date;
  revokedAt: Date | null;
}): IssuedCredential {
  return {
    id: row.id,
    record: row.record as unknown as ServiceRecord,
    publicToken: row.publicToken,
    issuedAt: row.issuedAt.toISOString(),
    revokedAt: row.revokedAt ? row.revokedAt.toISOString() : null,
  };
}

/**
 * Compute and freeze the member's record. Re-issuing UPSERTS the existing row in
 * place (there is no history table, so the snapshot it overwrites is gone) and
 * deliberately preserves publicToken, so regenerating does not break a link the
 * member has already shared.
 *
 * The offboard hook does NOT pass a client: it calls this against the singleton,
 * BEFORE and outside its own transaction, so a graduating member's final term is
 * captured while the membership is still ACTIVE without the audit write being
 * able to poison the offboard transaction (see src/platform/people.ts). Passing
 * a transaction client is supported for callers that already own one, but do not
 * reintroduce it on the offboard path.
 */
export async function issueServiceCredential(
  personId: string,
  client: PrismaClientOrTx = prisma,
): Promise<IssuedCredential> {
  const record = await computeServiceRecord(personId, client);
  const serialized = record as unknown as Prisma.InputJsonValue;

  const row = await client.serviceCredential.upsert({
    where: { personId },
    create: { personId, record: serialized },
    update: { record: serialized, issuedAt: new Date() },
    select: { id: true, record: true, publicToken: true, issuedAt: true, revokedAt: true },
  });

  await recordAudit(
    {
      actorPersonId: personId,
      action: "passport.issue",
      entityType: "ServiceCredential",
      entityId: row.id,
    },
    client,
  );

  return toIssued(row);
}

export async function getCredential(personId: string): Promise<IssuedCredential | null> {
  const row = await prisma.serviceCredential.findUnique({
    where: { personId },
    select: { id: true, record: true, publicToken: true, issuedAt: true, revokedAt: true },
  });
  return row ? toIssued(row) : null;
}

/**
 * 32 random bytes, base64url. The public credential page is unauthenticated, so
 * this token is the only thing standing between a URL and a member's name and
 * service history. It must never be derived from the person id or anything
 * else enumerable.
 *
 * The token also travels in a URL path, which posthog-js captures verbatim on
 * every pageview, so "/credential/" is registered in the PostHog scrub list
 * (src/platform/posthog/scrub-url.ts). That scrub is load-bearing, not cosmetic.
 */
function mintToken(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * Publish the member's credential and return its public token, issuing the
 * credential first if they have never generated one. Idempotent: an
 * already-published credential keeps its token so a shared link never breaks.
 */
export async function publishCredential(personId: string): Promise<string> {
  const existing = await getCredential(personId);
  if (!existing) await issueServiceCredential(personId);
  if (existing?.publicToken) return existing.publicToken;

  const token = mintToken();
  await prisma.serviceCredential.update({
    where: { personId },
    data: { publicToken: token },
  });
  await recordAudit({
    actorPersonId: personId,
    action: "passport.publish",
    entityType: "ServiceCredential",
    entityId: personId,
  });
  return token;
}

/** Retract the public URL. The credential itself survives; only the token is dropped. */
export async function unpublishCredential(personId: string): Promise<void> {
  await prisma.serviceCredential.updateMany({
    where: { personId },
    // unpublishedAt is stamped so this reads as a DECISION, not merely an absence.
    // Adding a wallet badge auto-publishes, and without this marker the member's
    // next badge refresh would quietly undo the retraction they just made.
    data: { publicToken: null, unpublishedAt: new Date() },
  });
  await recordAudit({
    actorPersonId: personId,
    action: "passport.unpublish",
    entityType: "ServiceCredential",
    entityId: personId,
  });
}

/**
 * Resolve a published credential for the PUBLIC page. Returns null for an
 * unknown token, an unpublished credential, or a revoked one, so every one of
 * those cases renders the same 404 and the page never distinguishes "wrong
 * token" from "retracted".
 */
export async function getCredentialByToken(token: string): Promise<IssuedCredential | null> {
  if (!token) return null;
  const row = await prisma.serviceCredential.findUnique({
    where: { publicToken: token },
    select: { id: true, record: true, publicToken: true, issuedAt: true, revokedAt: true },
  });
  if (!row || row.revokedAt) return null;
  return toIssued(row);
}

/**
 * Publish the credential so a wallet badge can carry a verifiable QR, unless the
 * member has already said no.
 *
 * Publishing is otherwise opt-in, and this is the one place it happens without
 * an explicit click. The justification is narrow: a QR is only of use to someone
 * who has a badge, so this reaches exactly the members who asked for one, and it
 * publishes nothing about anyone who never touches the feature.
 *
 * Returns the token to encode, or null when there is nothing publishable. Never
 * throws: badge issuance is best-effort, and a publishing failure must cost the
 * QR, not the badge.
 *
 * Deliberately does NOT publish when:
 *   - the member previously unpublished (unpublishedAt set). Re-publishing on
 *     the next refresh would override a choice they made on purpose.
 *   - the credential is revoked. A QR resolving to a 404 is worse than none.
 */
export async function autoPublishForBadge(personId: string): Promise<string | null> {
  try {
    const existing = await getCredential(personId);

    // No record yet: issue one, since a badge holder demonstrably has service to
    // show, then publish it.
    if (!existing) {
      await issueServiceCredential(personId);
      return publishCredential(personId);
    }

    if (existing.revokedAt) return null;
    if (existing.publicToken) return existing.publicToken;

    const row = await prisma.serviceCredential.findUnique({
      where: { personId },
      select: { unpublishedAt: true },
    });
    if (row?.unpublishedAt) return null;

    return await publishCredential(personId);
  } catch (error) {
    log.error("[passport] auto-publish for badge failed", errorAttrs(error, { personId }));
    return null;
  }
}
