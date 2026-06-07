import { prisma } from "@/platform/db";
import { personMirrorPayload, type PersonFieldMap } from "./mirror-map";
import { escapeFormulaString } from "./client";

export type AirtableWriter = {
  patchRecord(baseId: string, tableId: string, recordId: string, fields: Record<string, unknown>): Promise<unknown>;
  createRecord(baseId: string, tableId: string, fields: Record<string, unknown>): Promise<{ id: string }>;
};

/**
 * Full IO surface required by drainOutbox: write operations plus listAll for
 * the adopt-or-create guard. AirtableClient satisfies this type.
 */
export type MirrorIo = AirtableWriter & {
  listAll(
    baseId: string,
    tableId: string,
    opts?: { filterByFormula?: string }
  ): Promise<Array<{ id: string; fields: Record<string, unknown> }>>;
};

export type MirrorTarget = {
  enabled: boolean;
  baseId: string;
  peopleTableId: string;
  /** Field-ID map for this specific target base. Use ALL_PEOPLE_FIELDS for production. */
  fieldMap: PersonFieldMap;
};

const MAX_ATTEMPTS = 8;

/** Drain up to `batchSize` pending outbox rows. Returns how many were processed. */
export async function drainOutbox(
  writer: MirrorIo,
  target: MirrorTarget,
  batchSize = 10
): Promise<number> {
  if (!target.enabled) return 0;

  const rows = await prisma.outbox.findMany({
    where: { status: "PENDING" },
    orderBy: { createdAt: "asc" },
    take: batchSize,
  });

  let processed = 0;
  for (const row of rows) {
    // TODO(Task 5): route HipaaCertificate rows to the attachment push handler.
    // Until then, skip them so that enabling the mirror early cannot corrupt cert rows
    // (the Person handler would incorrectly look up the cert id as a person id, find null,
    // and mark the row FAILED with "entity no longer exists").
    if (row.entityType !== "Person") {
      continue;
    }
    try {
      const person = await prisma.person.findUnique({ where: { id: row.entityId } });
      if (!person) {
        await prisma.outbox.update({
          where: { id: row.id },
          data: { status: "FAILED", lastError: "entity no longer exists", processedAt: new Date() },
        });
        continue;
      }
      const payload = personMirrorPayload(person, target.fieldMap);
      const mapping = await prisma.mirrorRecord.findUnique({
        where: {
          entityType_entityId_baseId: {
            entityType: "Person",
            entityId: person.id,
            baseId: target.baseId,
          },
        },
      });
      if (mapping) {
        await writer.patchRecord(target.baseId, target.peopleTableId, mapping.recordId, payload);
      } else {
        // Adopt-or-create: a crash after createRecord but before the mapping insert,
        // or pre-existing rows (production cutover), must not produce duplicates.
        // Field NAMES are identical across production and sandbox targets.
        const adoptedId = await findExistingRecord(writer, target, person.id, person.netId, person.contactEmail);
        if (adoptedId) {
          await prisma.mirrorRecord.create({
            data: {
              entityType: "Person",
              entityId: person.id,
              baseId: target.baseId,
              recordId: adoptedId,
            },
          });
          await writer.patchRecord(target.baseId, target.peopleTableId, adoptedId, payload);
        } else {
          // Known limitation: createRecord precedes the mapping insert, so a manual
          // drain racing the live worker in this gap can produce a duplicate row.
          // Do not run manual drains while the worker is up.
          const created = await writer.createRecord(target.baseId, target.peopleTableId, payload);
          await prisma.mirrorRecord.create({
            data: {
              entityType: "Person",
              entityId: person.id,
              baseId: target.baseId,
              recordId: created.id,
            },
          });
        }
      }
      await prisma.outbox.update({
        where: { id: row.id },
        data: { status: "SENT", processedAt: new Date() },
      });
      processed++;
    } catch (error) {
      const attempts = row.attempts + 1;
      await prisma.outbox.update({
        where: { id: row.id },
        data: {
          attempts,
          lastError: error instanceof Error ? error.message.slice(0, 500) : String(error),
          status: attempts >= MAX_ATTEMPTS ? "FAILED" : "PENDING",
          ...(attempts >= MAX_ATTEMPTS ? { processedAt: new Date() } : {}),
        },
      });
    }
  }
  return processed;
}

/**
 * Search the target table for an existing record to adopt before creating.
 * Field NAMES are identical across production and sandbox targets, so we use
 * the logical name in the formula. Returns the record id if found, null if not.
 * If the person has neither netId nor contactEmail, skip the search entirely.
 */
async function findExistingRecord(
  io: MirrorIo,
  target: MirrorTarget,
  personId: string,
  netId: string | null,
  contactEmail: string | null
): Promise<string | null> {
  let formula: string;
  if (netId) {
    formula = `LOWER({NetID}) = '${escapeFormulaString(netId.toLowerCase())}'`;
  } else if (contactEmail) {
    formula = `LOWER({Contact Email}) = '${escapeFormulaString(contactEmail.toLowerCase())}'`;
  } else {
    return null;
  }
  const results = await io.listAll(target.baseId, target.peopleTableId, {
    filterByFormula: formula,
  });
  if (results.length > 1) {
    // Log the internal id only: netId/email are PII and do not belong in log storage.
    console.warn(`[mirror] ${results.length} target records match person ${personId}; adopting the first. Clean up duplicates in Airtable.`);
  }
  return results.length > 0 ? results[0].id : null;
}
