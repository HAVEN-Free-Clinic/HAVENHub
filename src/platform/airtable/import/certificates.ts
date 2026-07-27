/**
 * Backfill HIPAA certificates from Airtable's "All People" attachment field.
 *
 * One-directional: data flows FROM Airtable into Postgres. Nothing is written
 * back to Airtable.
 */

import { randomUUID } from "node:crypto";
import { prisma } from "@/platform/db";
import { recordAudit } from "@/platform/audit";
import { log, errorAttrs } from "@/platform/logging";
import { putObject, deleteObject } from "@/platform/storage";
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

    // Download the file. Catch errors so one bad URL does not abort the whole run.
    let bytes: Buffer;
    try {
      bytes = await download(att.url);
    } catch (err) {
      report.failures.push({
        recordId: record.id,
        reason: `download failed: ${err instanceof Error ? err.message.slice(0, 200) : String(err)}`,
      });
      continue;
    }
    const ext = mimeToExtension(att.type);
    // storedName is a random key, not `${row.id}.${ext}`, so the bytes can be
    // written to storage BEFORE the DB row exists. The viewer resolves a cert by
    // the row's storedName field, so decoupling it from the id is transparent.
    const storedName = `${randomUUID()}.${ext}`;

    // Write bytes FIRST, then create the row (#119). The old order committed the
    // row and wrote storage afterward, so a process interruption (Ctrl-C, timeout,
    // OOM) between the two left a row whose bytes never landed. The count>0 re-run
    // guard then skipped that person forever: My Info shows a certificate the
    // viewer 404s and no compliance manager can open. Writing the blob first makes
    // an interruption leave only a harmless, re-runnable orphaned blob.
    try {
      await putObject(storedName, bytes, att.type);
    } catch (err) {
      report.failures.push({
        recordId: record.id,
        reason: err instanceof Error ? err.message.slice(0, 200) : String(err),
      });
      continue;
    }

    // No enqueueMirror: data came FROM Airtable; pushing back duplicates.
    let cert;
    try {
      cert = await prisma.hipaaCertificate.create({
        data: {
          personId: person.id,
          fileName: att.filename,
          storedName,
          size: att.size,
          mimeType: att.type,
          source: "IMPORT",
        },
      });
    } catch (err) {
      // Row create failed after the blob write: delete the now-orphaned blob so a
      // failed record does not leave storage litter (harmless, but keep it tidy).
      await deleteObject(storedName).catch((cleanupErr) =>
        log.error(
          "[backfill-certs] failed to clean up blob after row-create error",
          errorAttrs(cleanupErr, { storedName }),
        ),
      );
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
