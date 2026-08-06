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
  /** refresh mode only: rows whose bytes were replaced. */
  refreshed: number;
  /**
   * refresh mode only: a person has a certificate row but their Airtable
   * attachment field is now absent or empty. That certificate exists in
   * neither Airtable nor storage and cannot be recovered by this script.
   */
  missingAttachment: number;
  failures: Array<{ recordId: string; reason: string }>;
};

type AirtableAttachment = {
  id: string;
  url: string;
  filename: string;
  size: number;
  type: string;
};

type PersonRef = { id: string };

type BackfillRecord = { id: string; fields: Record<string, unknown> };

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

/** Download + write-to-storage + create a brand-new HipaaCertificate row. */
async function createCertificateRow(
  recordId: string,
  person: PersonRef,
  att: AirtableAttachment,
  download: AttachmentDownloader,
  report: BackfillReport
): Promise<void> {
  // Download the file. Catch errors so one bad URL does not abort the whole run.
  let bytes: Buffer;
  try {
    bytes = await download(att.url);
  } catch (err) {
    report.failures.push({
      recordId,
      reason: `download failed: ${err instanceof Error ? err.message.slice(0, 200) : String(err)}`,
    });
    return;
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
      recordId,
      reason: err instanceof Error ? err.message.slice(0, 200) : String(err),
    });
    return;
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
      recordId,
      reason: err instanceof Error ? err.message.slice(0, 200) : String(err),
    });
    return;
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

/**
 * Refresh mode only: replace an existing HipaaCertificate row's bytes without
 * touching its compliance state (verifiedAt, verifiedById, completionDate,
 * source, uploadedAt, extraction, personId).
 */
async function refreshCertificateRow(
  recordId: string,
  person: PersonRef,
  existing: { id: string },
  att: AirtableAttachment,
  download: AttachmentDownloader,
  report: BackfillReport
): Promise<void> {
  let bytes: Buffer;
  try {
    bytes = await download(att.url);
  } catch (err) {
    report.failures.push({
      recordId,
      reason: `download failed: ${err instanceof Error ? err.message.slice(0, 200) : String(err)}`,
    });
    return;
  }
  const ext = mimeToExtension(att.type);
  const storedName = `${randomUUID()}.${ext}`;

  // Write bytes to a NEW key first, then repoint the row (mirrors the create
  // path's ordering rationale above). If refresh is interrupted between the
  // two, the row still resolves to its old storedName rather than a key that
  // was never written -- an orphan, not a dead row.
  try {
    await putObject(storedName, bytes, att.type);
  } catch (err) {
    report.failures.push({
      recordId,
      reason: err instanceof Error ? err.message.slice(0, 200) : String(err),
    });
    return;
  }

  // Do NOT delete the old storedName: it points into the blocked Blob store
  // being decommissioned, and a delete against R2 for a key that was never
  // there is a pointless no-op.
  try {
    await prisma.hipaaCertificate.update({
      where: { id: existing.id },
      data: {
        storedName,
        fileName: att.filename,
        size: att.size,
        mimeType: att.type,
      },
    });
  } catch (err) {
    // Row update failed after the blob write: clean up the now-orphaned blob,
    // same as the create path does.
    await deleteObject(storedName).catch((cleanupErr) =>
      log.error(
        "[backfill-certs] failed to clean up blob after row-refresh error",
        errorAttrs(cleanupErr, { storedName }),
      ),
    );
    report.failures.push({
      recordId,
      reason: err instanceof Error ? err.message.slice(0, 200) : String(err),
    });
    return;
  }

  // Distinct action from a fresh import: this replaced bytes on an existing,
  // possibly manager-verified row.
  await recordAudit({
    actorPersonId: null,
    action: "my-info.certificate_refresh",
    entityType: "HipaaCertificate",
    entityId: existing.id,
    after: { personId: person.id, storedName },
  });

  report.refreshed++;
}

/**
 * Refresh mode's per-record handling. Kept separate from the default
 * (non-refresh) loop body below so default behavior stays untouched.
 */
async function processRefreshRecord(
  record: BackfillRecord,
  download: AttachmentDownloader,
  report: BackfillReport,
  dryRun: boolean
): Promise<void> {
  const attachments = record.fields[AF.hipaaCertificate];
  const hasAttachment = Array.isArray(attachments) && attachments.length > 0;
  const atts = hasAttachment ? (attachments as AirtableAttachment[]) : [];

  const person = await prisma.person.findUnique({
    where: { airtableRecordId: record.id },
  });

  if (!person) {
    report.failures.push({ recordId: record.id, reason: "person not imported" });
    return;
  }

  // Refresh only the person's NEWEST row (matches the model's
  // @@index([personId, uploadedAt])). Any older duplicate rows are left alone.
  const existingCert = await prisma.hipaaCertificate.findFirst({
    where: { personId: person.id },
    orderBy: { uploadedAt: "desc" },
  });

  if (existingCert) {
    if (!hasAttachment) {
      // Gone from both Airtable and storage -- unrecoverable. Surface this
      // separately from peopleWithoutCerts; it is the number an operator
      // needs to know what was permanently lost.
      report.missingAttachment++;
      return;
    }
    if (dryRun) {
      report.refreshed++;
      return;
    }
    // Take the LAST attachment (Airtable appends; last = newest).
    await refreshCertificateRow(record.id, person, existingCert, atts[atts.length - 1], download, report);
    return;
  }

  // No existing row: fall through to today's create path so refresh mode
  // also picks up anyone who was missed originally.
  if (!hasAttachment) {
    report.peopleWithoutCerts++;
    return;
  }
  if (dryRun) {
    report.imported++;
    return;
  }
  await createCertificateRow(record.id, person, atts[atts.length - 1], download, report);
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
    /**
     * Replace the newest existing row's bytes instead of skipping people who
     * already have a certificate. Preserves verifiedAt, verifiedById,
     * completionDate, source, uploadedAt, extraction, and personId. Defaults
     * to false so today's behavior is unchanged.
     */
    refresh?: boolean;
  }
): Promise<BackfillReport> {
  const report: BackfillReport = {
    imported: 0,
    skippedExisting: 0,
    peopleWithoutCerts: 0,
    refreshed: 0,
    missingAttachment: 0,
    failures: [],
  };

  const records = await reader.listAll(options.baseId, options.peopleTableId);

  for (const record of records) {
    if (options.refresh) {
      await processRefreshRecord(record, download, report, options.dryRun);
      continue;
    }

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
