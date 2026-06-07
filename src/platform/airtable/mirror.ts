import fs from "node:fs/promises";
import path from "node:path";
import { prisma } from "@/platform/db";
import { config } from "@/platform/config";
import { personMirrorPayload, type PersonFieldMap } from "./mirror-map";
import { escapeFormulaString } from "./client";

export type AirtableWriter = {
  patchRecord(baseId: string, tableId: string, recordId: string, fields: Record<string, unknown>): Promise<unknown>;
  createRecord(baseId: string, tableId: string, fields: Record<string, unknown>): Promise<{ id: string }>;
};

/**
 * Full IO surface required by drainOutbox: write operations plus listAll for
 * the adopt-or-create guard, and uploadAttachment for HIPAA certs.
 * AirtableClient satisfies this type.
 */
export type MirrorIo = AirtableWriter & {
  listAll(
    baseId: string,
    tableId: string,
    opts?: { filterByFormula?: string }
  ): Promise<Array<{ id: string; fields: Record<string, unknown> }>>;
  uploadAttachment(
    baseId: string,
    recordId: string,
    fieldId: string,
    file: { name: string; type: string; base64: string }
  ): Promise<unknown>;
};

export type MirrorTarget = {
  enabled: boolean;
  baseId: string;
  peopleTableId: string;
  /** Field-ID map for this specific target base. Use ALL_PEOPLE_FIELDS for production. */
  fieldMap: PersonFieldMap;
  /**
   * Airtable field ID for the HIPAA certificate attachment field on the people table.
   * When null the certificate push step is skipped (configured-off is success, not failure).
   */
  hipaaFieldId: string | null;
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
    if (row.entityType === "Person") {
      processed += await drainPersonRow(writer, target, row) ? 1 : 0;
    } else if (row.entityType === "HipaaCertificate") {
      processed += await drainHipaaRow(writer, target, row) ? 1 : 0;
    }
    // Unknown entity types are silently skipped to avoid polluting unrelated rows.
  }
  return processed;
}

type OutboxRow = Awaited<ReturnType<typeof prisma.outbox.findMany>>[number];

/**
 * Handle a single "Person" outbox row. Returns true when the row was fully
 * processed (SENT), false if it was skipped or failed.
 */
async function drainPersonRow(
  writer: MirrorIo,
  target: MirrorTarget,
  row: OutboxRow
): Promise<boolean> {
  try {
    const person = await prisma.person.findUnique({ where: { id: row.entityId } });
    if (!person) {
      await prisma.outbox.update({
        where: { id: row.id },
        data: { status: "FAILED", lastError: "entity no longer exists", processedAt: new Date() },
      });
      return false;
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
    return true;
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
    return false;
  }
}

/**
 * Handle a single "HipaaCertificate" outbox row.
 *
 * Success conditions:
 *   - cert row found + hipaaFieldId set + person mirrored: upload attachment, mark SENT.
 *   - cert row found + hipaaFieldId NOT set (target.hipaaFieldId is null): mark SENT.
 *     Configured-off is success, not a failure -- the field does not exist in this base yet.
 *
 * Retry (stays PENDING, increments attempts):
 *   - Person's MirrorRecord mapping does not exist yet (person not mirrored yet; will retry).
 *
 * Failure (marks FAILED):
 *   - cert row not found in DB (entity deleted).
 *   - file missing from disk.
 *   - IO error from uploadAttachment (caught by the outer try/catch).
 */
async function drainHipaaRow(
  writer: MirrorIo,
  target: MirrorTarget,
  row: OutboxRow
): Promise<boolean> {
  try {
    // Load the cert row.
    const cert = await prisma.hipaaCertificate.findUnique({ where: { id: row.entityId } });
    if (!cert) {
      await prisma.outbox.update({
        where: { id: row.id },
        data: { status: "FAILED", lastError: "entity no longer exists", processedAt: new Date() },
      });
      return false;
    }

    // If the attachment field is not configured for this target, treat as success.
    // This lets teams enable the mirror before the attachment field exists in their base.
    if (!target.hipaaFieldId) {
      await prisma.outbox.update({
        where: { id: row.id },
        data: { status: "SENT", processedAt: new Date() },
      });
      return true;
    }

    // Look up the person's MirrorRecord mapping for this target.
    const personMapping = await prisma.mirrorRecord.findUnique({
      where: {
        entityType_entityId_baseId: {
          entityType: "Person",
          entityId: cert.personId,
          baseId: target.baseId,
        },
      },
    });
    if (!personMapping) {
      // Person has not been mirrored yet; leave PENDING and increment attempts.
      // Enqueue a Person outbox row for this person if none is already PENDING, so
      // the person mirrors on the next pass and this cert can self-heal on its retry.
      const existingPersonRow = await prisma.outbox.findFirst({
        where: { entityType: "Person", entityId: cert.personId, status: "PENDING" },
      });
      if (!existingPersonRow) {
        await prisma.outbox.create({
          data: {
            entityType: "Person",
            entityId: cert.personId,
            operation: "upsert",
            changedFields: [],
            status: "PENDING",
          },
        });
      }
      const attempts = row.attempts + 1;
      await prisma.outbox.update({
        where: { id: row.id },
        data: {
          attempts,
          lastError: "person not mirrored yet; will retry",
          status: attempts >= MAX_ATTEMPTS ? "FAILED" : "PENDING",
          ...(attempts >= MAX_ATTEMPTS ? { processedAt: new Date() } : {}),
        },
      });
      return false;
    }

    // Read the file from disk.
    const diskPath = path.join(config.UPLOAD_DIR, cert.storedName);
    let fileBuffer: Buffer;
    try {
      fileBuffer = await fs.readFile(diskPath);
    } catch {
      await prisma.outbox.update({
        where: { id: row.id },
        data: {
          status: "FAILED",
          lastError: `file not found on disk: ${cert.storedName}`,
          processedAt: new Date(),
        },
      });
      return false;
    }

    // Upload via the content API.
    const base64 = fileBuffer.toString("base64");
    await writer.uploadAttachment(target.baseId, personMapping.recordId, target.hipaaFieldId, {
      name: cert.fileName,
      type: cert.mimeType,
      base64,
    });

    await prisma.outbox.update({
      where: { id: row.id },
      data: { status: "SENT", processedAt: new Date() },
    });
    return true;
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
    return false;
  }
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
