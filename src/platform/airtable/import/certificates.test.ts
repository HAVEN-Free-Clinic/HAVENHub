/**
 * TDD tests for backfillCertificates.
 *
 * Uses the real test database and a fake AirtableReader + fake downloader.
 * No real HTTP calls are made.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import path from "node:path";
import fs from "node:fs/promises";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { config } from "@/platform/config";
import { ALL_PEOPLE_ATTACHMENT_FIELDS as AF } from "@/platform/airtable/fields";
import * as storage from "@/platform/storage";
import { backfillCertificates, type AttachmentDownloader } from "./certificates";
import type { AirtableReader } from "./importer";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function createPerson(overrides: {
  name?: string;
  airtableRecordId?: string;
  contactEmail?: string;
} = {}) {
  return prisma.person.create({
    data: {
      name: overrides.name ?? "Test Person",
      airtableRecordId: overrides.airtableRecordId,
      contactEmail: overrides.contactEmail,
    },
  });
}

/** Build a fake Airtable attachment object (the shape Airtable returns). */
function fakeAttachment(overrides: {
  id?: string;
  url?: string;
  filename?: string;
  size?: number;
  type?: string;
} = {}) {
  return {
    id: overrides.id ?? "att001",
    url: overrides.url ?? "https://example.com/cert.pdf",
    filename: overrides.filename ?? "hipaa_cert.pdf",
    size: overrides.size ?? 1024,
    type: overrides.type ?? "application/pdf",
  };
}

/** Minimal fake downloader that returns a fixed buffer. */
function makeDownloader(buf: Buffer = Buffer.from("fake-cert-bytes")): AttachmentDownloader {
  return vi.fn(async (_url: string) => buf);
}

const OPTS = {
  baseId: "appkxTQ19GmaHgW1O",
  peopleTableId: "tblnHgBpknuqWvx9c",
  dryRun: false,
};

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(async () => {
  await resetDb();
  // Clean upload dir between tests.
  try {
    const entries = await fs.readdir(config.UPLOAD_DIR);
    await Promise.all(
      entries.map((e) => fs.rm(path.join(config.UPLOAD_DIR, e), { force: true, recursive: true }))
    );
  } catch {
    // dir may not exist yet -- fine
  }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("backfillCertificates", () => {
  it("imports the newest (last) attachment for a mapped person", async () => {
    const person = await createPerson({ airtableRecordId: "recAlice" });

    const olderAtt = fakeAttachment({ id: "att001", filename: "old_cert.pdf", url: "https://example.com/old.pdf" });
    const newerAtt = fakeAttachment({ id: "att002", filename: "new_cert.pdf", url: "https://example.com/new.pdf" });

    const reader: AirtableReader = {
      async listAll() {
        return [
          {
            id: "recAlice",
            fields: {
              [AF.hipaaCertificate]: [olderAtt, newerAtt],
            },
          },
        ];
      },
    };

    const fakeBytes = Buffer.from("pdf-content");
    const downloader = makeDownloader(fakeBytes);

    const report = await backfillCertificates(reader, downloader, OPTS);

    expect(report.imported).toBe(1);
    expect(report.skippedExisting).toBe(0);
    expect(report.peopleWithoutCerts).toBe(0);
    expect(report.failures).toHaveLength(0);

    // DB: one HipaaCertificate row with source IMPORT
    const certs = await prisma.hipaaCertificate.findMany({ where: { personId: person.id } });
    expect(certs).toHaveLength(1);
    expect(certs[0].source).toBe("IMPORT");
    expect(certs[0].fileName).toBe("new_cert.pdf");
    expect(certs[0].mimeType).toBe("application/pdf");

    // Disk: the stored file exists and contains the downloaded bytes
    const diskPath = path.join(config.UPLOAD_DIR, certs[0].storedName);
    const diskBytes = await fs.readFile(diskPath);
    expect(diskBytes.equals(fakeBytes)).toBe(true);

    // storedName extension matches mime
    expect(certs[0].storedName).toMatch(/\.pdf$/);

    // Downloader was called with the newest attachment's URL
    expect(downloader).toHaveBeenCalledWith(newerAtt.url);
    expect(downloader).toHaveBeenCalledTimes(1);
  });

  it("writes the certificate bytes to storage BEFORE creating the DB row (#119)", async () => {
    // The old order committed the row, then wrote storage; an interruption between
    // the two orphaned the row forever (the count>0 re-run guard skips it). Writing
    // the blob first means a crash leaves only a harmless, re-runnable blob. Assert
    // the invariant directly: no row exists at the moment the bytes are written.
    const person = await createPerson({ airtableRecordId: "recRace" });
    const reader: AirtableReader = {
      async listAll() {
        return [{ id: "recRace", fields: { [AF.hipaaCertificate]: [fakeAttachment()] } }];
      },
    };

    let rowCountWhenBytesWritten = -1;
    const spy = vi.spyOn(storage, "putObject").mockImplementation(async () => {
      rowCountWhenBytesWritten = await prisma.hipaaCertificate.count({ where: { personId: person.id } });
    });
    try {
      await backfillCertificates(reader, makeDownloader(), OPTS);
    } finally {
      spy.mockRestore();
    }

    expect(rowCountWhenBytesWritten).toBe(0); // bytes written before any row -> no orphan
    expect(await prisma.hipaaCertificate.count({ where: { personId: person.id } })).toBe(1);
  });

  it("skips a person who already has ANY HipaaCertificate row", async () => {
    const person = await createPerson({ airtableRecordId: "recBob" });

    // Pre-existing certificate
    await prisma.hipaaCertificate.create({
      data: {
        personId: person.id,
        fileName: "existing.pdf",
        storedName: "existing.pdf",
        size: 500,
        mimeType: "application/pdf",
      },
    });

    const reader: AirtableReader = {
      async listAll() {
        return [
          {
            id: "recBob",
            fields: { [AF.hipaaCertificate]: [fakeAttachment()] },
          },
        ];
      },
    };

    const downloader = makeDownloader();
    const report = await backfillCertificates(reader, downloader, OPTS);

    expect(report.skippedExisting).toBe(1);
    expect(report.imported).toBe(0);
    // downloader should NOT have been called
    expect(downloader).not.toHaveBeenCalled();
    // Still only one cert row
    const count = await prisma.hipaaCertificate.count({ where: { personId: person.id } });
    expect(count).toBe(1);
  });

  it("creates a failure entry for an Airtable record with no matching Person in the DB", async () => {
    const reader: AirtableReader = {
      async listAll() {
        return [
          {
            id: "recGhost",
            fields: { [AF.hipaaCertificate]: [fakeAttachment()] },
          },
        ];
      },
    };

    const downloader = makeDownloader();
    const report = await backfillCertificates(reader, downloader, OPTS);

    expect(report.failures).toHaveLength(1);
    expect(report.failures[0].recordId).toBe("recGhost");
    expect(report.failures[0].reason).toMatch(/person not imported/i);
    expect(report.imported).toBe(0);
    expect(downloader).not.toHaveBeenCalled();
  });

  it("dry-run: counts but does not download or write anything", async () => {
    const person = await createPerson({ airtableRecordId: "recCarol" });

    const reader: AirtableReader = {
      async listAll() {
        return [
          {
            id: "recCarol",
            fields: { [AF.hipaaCertificate]: [fakeAttachment()] },
          },
        ];
      },
    };

    const downloader = makeDownloader();
    const report = await backfillCertificates(reader, downloader, {
      ...OPTS,
      dryRun: true,
    });

    // Counts what would import
    expect(report.imported).toBe(1);
    expect(report.failures).toHaveLength(0);
    // Downloader was NOT called
    expect(downloader).not.toHaveBeenCalled();
    // No DB rows written
    const count = await prisma.hipaaCertificate.count({ where: { personId: person.id } });
    expect(count).toBe(0);
    // No disk files
    const uploadDir = config.UPLOAD_DIR;
    let entries: string[] = [];
    try {
      entries = await fs.readdir(uploadDir);
    } catch {
      // dir may not exist yet -- fine
    }
    // Filter to cert files (not hidden/lock files)
    const certFiles = entries.filter((e) => !e.startsWith("."));
    expect(certFiles).toHaveLength(0);
  });

  it("audit row is created per import in apply mode with action my-info.certificate_import", async () => {
    const person = await createPerson({ airtableRecordId: "recEve" });

    const reader: AirtableReader = {
      async listAll() {
        return [
          {
            id: "recEve",
            fields: { [AF.hipaaCertificate]: [fakeAttachment({ filename: "eve_cert.pdf" })] },
          },
        ];
      },
    };

    await backfillCertificates(reader, makeDownloader(), OPTS);

    const audit = await prisma.auditLog.findFirst({
      where: { action: "my-info.certificate_import" },
    });
    expect(audit).not.toBeNull();
    expect(audit!.actorPersonId).toBeNull(); // system actor
    const after = audit!.after as Record<string, unknown>;
    expect(after.personId).toBe(person.id);
    expect(after.fileName).toBe("eve_cert.pdf");
  });

  it("dry-run: no audit rows created", async () => {
    await createPerson({ airtableRecordId: "recFrank" });

    const reader: AirtableReader = {
      async listAll() {
        return [
          {
            id: "recFrank",
            fields: { [AF.hipaaCertificate]: [fakeAttachment()] },
          },
        ];
      },
    };

    await backfillCertificates(reader, makeDownloader(), { ...OPTS, dryRun: true });

    const auditCount = await prisma.auditLog.count({
      where: { action: "my-info.certificate_import" },
    });
    expect(auditCount).toBe(0);
  });

  it("records with no attachments in the hipaaCertificate field increment peopleWithoutCerts", async () => {
    await createPerson({ airtableRecordId: "recGreg" });

    const reader: AirtableReader = {
      async listAll() {
        return [
          {
            id: "recGreg",
            fields: {
              // no hipaaCertificate field at all -- Airtable omits empty attachment fields
            },
          },
        ];
      },
    };

    const report = await backfillCertificates(reader, makeDownloader(), OPTS);

    expect(report.peopleWithoutCerts).toBe(1);
    expect(report.imported).toBe(0);
  });

  it("mime extension mapping: image/jpeg -> .jpg storedName", async () => {
    const person = await createPerson({ airtableRecordId: "recHana" });

    const jpegAtt = fakeAttachment({ filename: "cert.jpg", type: "image/jpeg" });

    const reader: AirtableReader = {
      async listAll() {
        return [
          {
            id: "recHana",
            fields: { [AF.hipaaCertificate]: [jpegAtt] },
          },
        ];
      },
    };

    await backfillCertificates(reader, makeDownloader(), OPTS);

    const cert = await prisma.hipaaCertificate.findFirst({ where: { personId: person.id } });
    expect(cert).not.toBeNull();
    expect(cert!.storedName).toMatch(/\.jpg$/);
    expect(cert!.mimeType).toBe("image/jpeg");
  });

  it("mime extension mapping: image/png -> .png storedName", async () => {
    const person = await createPerson({ airtableRecordId: "recIra" });

    const pngAtt = fakeAttachment({ filename: "cert.png", type: "image/png" });

    const reader: AirtableReader = {
      async listAll() {
        return [
          {
            id: "recIra",
            fields: { [AF.hipaaCertificate]: [pngAtt] },
          },
        ];
      },
    };

    await backfillCertificates(reader, makeDownloader(), OPTS);

    const cert = await prisma.hipaaCertificate.findFirst({ where: { personId: person.id } });
    expect(cert).not.toBeNull();
    expect(cert!.storedName).toMatch(/\.png$/);
  });

  it("mime extension mapping: unknown mime -> .bin storedName", async () => {
    const person = await createPerson({ airtableRecordId: "recJim" });

    const unknownAtt = fakeAttachment({ filename: "cert.xyz", type: "application/octet-stream" });

    const reader: AirtableReader = {
      async listAll() {
        return [
          {
            id: "recJim",
            fields: { [AF.hipaaCertificate]: [unknownAtt] },
          },
        ];
      },
    };

    await backfillCertificates(reader, makeDownloader(), OPTS);

    const cert = await prisma.hipaaCertificate.findFirst({ where: { personId: person.id } });
    expect(cert).not.toBeNull();
    expect(cert!.storedName).toMatch(/\.bin$/);
  });
});

// ---------------------------------------------------------------------------
// Refresh mode
// ---------------------------------------------------------------------------

describe("backfillCertificates with refresh: true", () => {
  it("replaces storedName but leaves verifiedAt, verifiedById, and completionDate unchanged (the whole point of refresh mode)", async () => {
    const person = await createPerson({ airtableRecordId: "recAlice" });
    const manager = await createPerson({ name: "Manager Verifier" });

    const verifiedAt = new Date("2024-03-01T12:00:00Z");
    const completionDate = new Date("2024-02-15T00:00:00Z");
    const existing = await prisma.hipaaCertificate.create({
      data: {
        personId: person.id,
        fileName: "old_cert.pdf",
        storedName: "old-blocked-blob-key.pdf",
        size: 500,
        mimeType: "application/pdf",
        source: "IMPORT",
        verifiedAt,
        verifiedById: manager.id,
        completionDate,
      },
    });

    const reader: AirtableReader = {
      async listAll() {
        return [
          {
            id: "recAlice",
            fields: { [AF.hipaaCertificate]: [fakeAttachment({ filename: "refreshed_cert.pdf" })] },
          },
        ];
      },
    };

    const fakeBytes = Buffer.from("refreshed-bytes");
    const downloader = makeDownloader(fakeBytes);

    const report = await backfillCertificates(reader, downloader, { ...OPTS, refresh: true });

    expect(report.refreshed).toBe(1);
    expect(report.imported).toBe(0);
    expect(report.missingAttachment).toBe(0);
    expect(report.failures).toHaveLength(0);

    // Still exactly one row -- the row was updated, not replaced.
    const certs = await prisma.hipaaCertificate.findMany({ where: { personId: person.id } });
    expect(certs).toHaveLength(1);
    const updated = certs[0];

    expect(updated.id).toBe(existing.id);
    expect(updated.storedName).not.toBe("old-blocked-blob-key.pdf");
    expect(updated.storedName).toMatch(/\.pdf$/);
    expect(updated.fileName).toBe("refreshed_cert.pdf");

    // The whole point: verification and completion state must survive byte-for-byte.
    expect(updated.verifiedAt?.toISOString()).toBe(verifiedAt.toISOString());
    expect(updated.verifiedById).toBe(manager.id);
    expect(updated.completionDate?.toISOString()).toBe(completionDate.toISOString());
    expect(updated.source).toBe("IMPORT");

    // New bytes actually landed under the new key.
    const diskBytes = await fs.readFile(path.join(config.UPLOAD_DIR, updated.storedName));
    expect(diskBytes.equals(fakeBytes)).toBe(true);

    // Distinct audit action, naming the person and the new storedName.
    const audit = await prisma.auditLog.findFirst({ where: { action: "my-info.certificate_refresh" } });
    expect(audit).not.toBeNull();
    const after = audit!.after as Record<string, unknown>;
    expect(after.personId).toBe(person.id);
    expect(after.storedName).toBe(updated.storedName);
  });

  it("writes the new bytes to storage BEFORE repointing the row (an interruption leaves an orphan, not a dead row)", async () => {
    const person = await createPerson({ airtableRecordId: "recRefreshRace" });
    await prisma.hipaaCertificate.create({
      data: {
        personId: person.id,
        fileName: "old.pdf",
        storedName: "old-key.pdf",
        size: 100,
        mimeType: "application/pdf",
        source: "IMPORT",
      },
    });

    const reader: AirtableReader = {
      async listAll() {
        return [
          { id: "recRefreshRace", fields: { [AF.hipaaCertificate]: [fakeAttachment()] } },
        ];
      },
    };

    let storedNameWhenBytesWritten: string | undefined;
    const spy = vi.spyOn(storage, "putObject").mockImplementation(async () => {
      const row = await prisma.hipaaCertificate.findFirst({ where: { personId: person.id } });
      storedNameWhenBytesWritten = row?.storedName;
    });
    try {
      await backfillCertificates(reader, makeDownloader(), { ...OPTS, refresh: true });
    } finally {
      spy.mockRestore();
    }

    // At the moment bytes were written, the row still pointed at the OLD key --
    // the update had not happened yet.
    expect(storedNameWhenBytesWritten).toBe("old-key.pdf");

    const row = await prisma.hipaaCertificate.findFirst({ where: { personId: person.id } });
    expect(row?.storedName).not.toBe("old-key.pdf");
  });

  it("still creates a row for a person with no existing certificate (refresh mode also imports the missed)", async () => {
    const person = await createPerson({ airtableRecordId: "recNoRowYet" });

    const reader: AirtableReader = {
      async listAll() {
        return [
          { id: "recNoRowYet", fields: { [AF.hipaaCertificate]: [fakeAttachment({ filename: "fresh.pdf" })] } },
        ];
      },
    };

    const report = await backfillCertificates(reader, makeDownloader(), { ...OPTS, refresh: true });

    expect(report.imported).toBe(1);
    expect(report.refreshed).toBe(0);
    expect(report.missingAttachment).toBe(0);

    const cert = await prisma.hipaaCertificate.findFirst({ where: { personId: person.id } });
    expect(cert).not.toBeNull();
    expect(cert!.fileName).toBe("fresh.pdf");
    expect(cert!.source).toBe("IMPORT");
  });

  it("counts a row whose Airtable attachment is now gone as missingAttachment and leaves the row untouched", async () => {
    const person = await createPerson({ airtableRecordId: "recGoneFromAirtable" });
    const existing = await prisma.hipaaCertificate.create({
      data: {
        personId: person.id,
        fileName: "still-here.pdf",
        storedName: "still-here-key.pdf",
        size: 321,
        mimeType: "application/pdf",
        source: "IMPORT",
        verifiedAt: new Date("2024-01-01T00:00:00Z"),
        completionDate: new Date("2023-12-01T00:00:00Z"),
      },
    });

    const reader: AirtableReader = {
      async listAll() {
        return [
          {
            id: "recGoneFromAirtable",
            fields: {
              // Airtable omits the field entirely when the attachment is gone.
            },
          },
        ];
      },
    };

    const downloader = makeDownloader();
    const report = await backfillCertificates(reader, downloader, { ...OPTS, refresh: true });

    expect(report.missingAttachment).toBe(1);
    expect(report.refreshed).toBe(0);
    expect(report.imported).toBe(0);
    expect(downloader).not.toHaveBeenCalled();

    const row = await prisma.hipaaCertificate.findUnique({ where: { id: existing.id } });
    expect(row?.storedName).toBe("still-here-key.pdf");
    expect(row?.verifiedAt?.toISOString()).toBe("2024-01-01T00:00:00.000Z");
    expect(row?.completionDate?.toISOString()).toBe("2023-12-01T00:00:00.000Z");
  });

  it("dry-run refresh classifies all four cases without downloading or writing anything", async () => {
    const withRowAndAttachment = await createPerson({ airtableRecordId: "recWithBoth", name: "Has Row And Attachment" });
    const rowKept = await prisma.hipaaCertificate.create({
      data: {
        personId: withRowAndAttachment.id,
        fileName: "a.pdf",
        storedName: "a-key.pdf",
        size: 1,
        mimeType: "application/pdf",
        source: "IMPORT",
      },
    });

    const withRowNoAttachment = await createPerson({ airtableRecordId: "recRowOnly", name: "Has Row Only" });
    await prisma.hipaaCertificate.create({
      data: {
        personId: withRowNoAttachment.id,
        fileName: "b.pdf",
        storedName: "b-key.pdf",
        size: 1,
        mimeType: "application/pdf",
        source: "IMPORT",
      },
    });

    await createPerson({ airtableRecordId: "recAttachmentOnly", name: "Has Attachment Only" });
    await createPerson({ airtableRecordId: "recNeither", name: "Has Neither" });

    const reader: AirtableReader = {
      async listAll() {
        return [
          { id: "recWithBoth", fields: { [AF.hipaaCertificate]: [fakeAttachment()] } },
          { id: "recRowOnly", fields: {} },
          { id: "recAttachmentOnly", fields: { [AF.hipaaCertificate]: [fakeAttachment()] } },
          { id: "recNeither", fields: {} },
        ];
      },
    };

    const downloader = makeDownloader();
    const report = await backfillCertificates(reader, downloader, { ...OPTS, refresh: true, dryRun: true });

    expect(report.refreshed).toBe(1);
    expect(report.missingAttachment).toBe(1);
    expect(report.imported).toBe(1);
    expect(report.peopleWithoutCerts).toBe(1);
    expect(report.failures).toHaveLength(0);

    // No downloads at all.
    expect(downloader).not.toHaveBeenCalled();

    // The would-be-refreshed row was not actually touched.
    const untouched = await prisma.hipaaCertificate.findUnique({ where: { id: rowKept.id } });
    expect(untouched?.storedName).toBe("a-key.pdf");

    // No new rows were created for the would-be-imported person.
    const notCreated = await prisma.person.findUnique({ where: { airtableRecordId: "recAttachmentOnly" } });
    const notCreatedCount = await prisma.hipaaCertificate.count({ where: { personId: notCreated!.id } });
    expect(notCreatedCount).toBe(0);

    // No audit rows in dry-run.
    const auditCount = await prisma.auditLog.count({
      where: { action: { in: ["my-info.certificate_refresh", "my-info.certificate_import"] } },
    });
    expect(auditCount).toBe(0);
  });
});
