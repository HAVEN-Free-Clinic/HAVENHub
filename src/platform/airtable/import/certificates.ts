/**
 * Backfill HIPAA certificates from Airtable's "All People" attachment field.
 *
 * DOES NOT enqueue outbox mirror rows: the data came FROM Airtable, so pushing
 * it back would create duplicates.
 */

import path from "node:path";
import fs from "node:fs/promises";
import { prisma } from "@/platform/db";
import { recordAudit } from "@/platform/audit";
import { config } from "@/platform/config";
import { ALL_PEOPLE_ATTACHMENT_FIELDS as AF } from "@/platform/airtable/fields";
import type { AirtableReader } from "./importer";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type AttachmentDownloader = (url: string) => Promise<Buffer>;

export type BackfillReport = {
  imported: number;
  skippedExisting: number;
  peopleWithoutCerts: number;
  failures: Array<{ recordId: string; reason: string }>;
};

type AirtableAttachment = {
  id: string;
  url: string;
  filename: string;
  size: number;
  type: string;
};

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function mimeToExtension(mimeType: string): string {
  switch (mimeType) {
    case "application/pdf":
      return "pdf";
    case "image/jpeg":
      return "jpg";
    case "image/png":
      return "png";
    default:
      return "bin";
  }
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export async function backfillCertificates(
  reader: AirtableReader,
  download: AttachmentDownloader,
  options: {
    baseId: string;
    peopleTableId: string;
    dryRun: boolean;
  }
): Promise<BackfillReport> {
  const report: BackfillReport = {
    imported: 0,
    skippedExisting: 0,
    peopleWithoutCerts: 0,
    failures: [],
  };

  const records = await reader.listAll(options.baseId, options.peopleTableId);

  for (const record of records) {
    const attachments = record.fields[AF.hipaaCertificate];

    // Airtable omits the field entirely when empty -- treat both absent and
    // empty array the same way.
    if (!Array.isArray(attachments) || attachments.length === 0) {
      report.peopleWithoutCerts++;
      continue;
    }

    const atts = attachments as AirtableAttachment[];

    // Find the matching Person by airtableRecordId.
    const person = await prisma.person.findUnique({
      where: { airtableRecordId: record.id },
    });

    if (!person) {
      report.failures.push({ recordId: record.id, reason: "person not imported" });
      continue;
    }

    // Skip if they already have ANY HipaaCertificate row.
    const existingCount = await prisma.hipaaCertificate.count({
      where: { personId: person.id },
    });

    if (existingCount > 0) {
      report.skippedExisting++;
      continue;
    }

    // In dry-run, count but do no I/O.
    if (options.dryRun) {
      report.imported++;
      continue;
    }

    // Take the LAST attachment (Airtable appends; last = newest).
    const att = atts[atts.length - 1];

    // Download the file.
    const bytes = await download(att.url);
    const ext = mimeToExtension(att.type);

    // Write-after-commit pattern: create DB row first, then write disk.
    const cert = await prisma.$transaction(async (tx) => {
      const created = await tx.hipaaCertificate.create({
        data: {
          personId: person.id,
          fileName: att.filename,
          storedName: "pending",
          size: att.size,
          mimeType: att.type,
          source: "IMPORT",
        },
      });

      const storedName = `${created.id}.${ext}`;

      const updated = await tx.hipaaCertificate.update({
        where: { id: created.id },
        data: { storedName },
      });

      // No enqueueMirror: data came FROM Airtable; pushing back duplicates.

      return updated;
    });

    // Write bytes to disk (after tx commits).
    const uploadDir = config.UPLOAD_DIR;
    const diskPath = path.join(uploadDir, cert.storedName);

    try {
      await fs.mkdir(uploadDir, { recursive: true });
      await fs.writeFile(diskPath, bytes);
    } catch (err) {
      // Disk write failed: clean up the DB row so the record is not orphaned.
      try {
        await prisma.hipaaCertificate.delete({ where: { id: cert.id } });
      } catch (cleanupErr) {
        console.error(
          "[backfill-certs] failed to clean up cert row after disk error",
          cert.id,
          cleanupErr
        );
      }
      report.failures.push({
        recordId: record.id,
        reason: err instanceof Error ? err.message.slice(0, 200) : String(err),
      });
      continue;
    }

    // Audit (system actor = null).
    await recordAudit({
      actorPersonId: null,
      action: "my-info.certificate_import",
      entityType: "HipaaCertificate",
      entityId: cert.id,
      after: { personId: person.id, fileName: att.filename },
    });

    report.imported++;
  }

  return report;
}
