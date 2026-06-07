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
      entries.map((e) => fs.rm(path.join(config.UPLOAD_DIR, e), { force: true }))
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

  it("no outbox rows are created for imported certificates", async () => {
    await createPerson({ airtableRecordId: "recDave" });

    const reader: AirtableReader = {
      async listAll() {
        return [
          {
            id: "recDave",
            fields: { [AF.hipaaCertificate]: [fakeAttachment()] },
          },
        ];
      },
    };

    await backfillCertificates(reader, makeDownloader(), OPTS);

    const outboxCount = await prisma.outbox.count({
      where: { entityType: "HipaaCertificate" },
    });
    expect(outboxCount).toBe(0);
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
