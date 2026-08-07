/**
 * Issuing and reading a member's service credential.
 *
 * Issuance SNAPSHOTS the computed record (see service-record.ts). Nothing in the
 * app renders a live computation: the certificate PDF and the public credential
 * page both read this frozen JSON, which is what keeps them in agreement and
 * what stops a public URL from surfacing a record the member never published.
 */

import type { Prisma } from "@prisma/client";
import { prisma } from "@/platform/db";
import { recordAudit } from "@/platform/audit";
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
 * Compute and freeze the member's record. Re-issuing updates the existing row in
 * place and deliberately preserves publicToken, so regenerating does not break a
 * link the member has already shared.
 *
 * Pass `client` to snapshot inside a caller's transaction (the offboard hook
 * does this, so a graduating member's final term is captured before their
 * membership is flipped to REMOVED).
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
