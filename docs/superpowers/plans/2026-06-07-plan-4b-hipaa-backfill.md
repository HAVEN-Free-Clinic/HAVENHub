# HIPAA Certificate Backfill from Airtable Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Backfill existing HIPAA certificates from Airtable's "All People" attachment field into the HipaaCertificate table, and show imported certs with a distinct label in the UI.

**Architecture:** Add a `source` enum column to `HipaaCertificate` (UPLOAD vs IMPORT), export a separate `ALL_PEOPLE_ATTACHMENT_FIELDS` constant in fields.ts (attachment fields must stay separate from the mirrored text-field set), implement `backfillCertificates` with full TDD, wire it to a CLI script, and update the HipaaPanel component to distinguish imported certs.

**Tech Stack:** Prisma (migration + client), TypeScript, Vitest (integration tests against test DB), tsx (CLI runner), Next.js server component (UI tweak)

---

## File Map

| File | Action | What it does |
|---|---|---|
| `prisma/schema.prisma` | Modify | Add `CertificateSource` enum + `source` field to `HipaaCertificate` |
| `prisma/migrations/<ts>_certificate-source/migration.sql` | Create (via `prisma migrate dev`) | ALTER TABLE adding enum + column with default |
| `src/platform/airtable/fields.ts` | Modify | Export `ALL_PEOPLE_ATTACHMENT_FIELDS` constant |
| `src/platform/airtable/import/certificates.ts` | Create | `backfillCertificates` function |
| `src/platform/airtable/import/certificates.test.ts` | Create | TDD tests for backfillCertificates |
| `src/modules/my-info/components/hipaa-panel.tsx` | Modify | Show "On file (imported from previous records)" for IMPORT source |
| `scripts/import-certificates.ts` | Create | CLI script (dry-run default, --apply) |
| `package.json` | Modify | Add `import:certs:dry` and `import:certs:apply` scripts |

---

## Task 1: Schema -- add `source` to `HipaaCertificate`

**Files:**
- Modify: `prisma/schema.prisma`
- Create (via migrate dev): `prisma/migrations/<ts>_certificate-source/migration.sql`

- [ ] **Step 1.1: Add enum and field to schema**

In `prisma/schema.prisma`, add the enum before the `HipaaCertificate` model, and add the `source` field inside the model:

```prisma
enum CertificateSource {
  UPLOAD
  IMPORT
}
```

Inside the `HipaaCertificate` model, after `mimeType String`, add:

```prisma
source      CertificateSource @default(UPLOAD)
```

The final `HipaaCertificate` model should look like:

```prisma
/// Uploaded HIPAA training certificates. One row per upload.
/// File bytes live on disk under UPLOAD_DIR/<storedName>; this row is the
/// source of truth for ownership and metadata. Cascade-deleted with the person.
model HipaaCertificate {
  id          String            @id @default(cuid())
  personId    String
  /// Original filename as supplied by the uploader (display only; never used in file I/O).
  fileName    String
  /// Server-generated filename stored under UPLOAD_DIR (e.g. "<cuid>.pdf"). Used for disk I/O.
  storedName  String
  size        Int
  mimeType    String
  source      CertificateSource @default(UPLOAD)
  uploadedAt  DateTime          @default(now())
  person      Person            @relation(fields: [personId], references: [id], onDelete: Cascade)

  @@index([personId, uploadedAt])
}
```

- [ ] **Step 1.2: Generate and inspect the migration**

```bash
cd /Users/jcarney/Documents/Code-Projects/HAVENHub && npx prisma migrate dev --name certificate-source 2>&1
```

Expected: migration file created under `prisma/migrations/<ts>_certificate-source/migration.sql`

Then read the generated SQL:

```bash
cat prisma/migrations/$(ls prisma/migrations | grep certificate-source)/migration.sql
```

Expected SQL should contain:
- `CREATE TYPE "CertificateSource" AS ENUM ('UPLOAD', 'IMPORT');`
- `ALTER TABLE "HipaaCertificate" ADD COLUMN "source" "CertificateSource" NOT NULL DEFAULT 'UPLOAD';`

**STOP if you see any DROP statements.** A DROP of an existing column, table, index, or constraint you did not put there is a data-loss red flag -- do not proceed until you understand why.

- [ ] **Step 1.3: Prepare the test database**

```bash
cd /Users/jcarney/Documents/Code-Projects/HAVENHub && npm run test:prepare 2>&1
```

Expected: exits 0, test DB migration applied.

- [ ] **Step 1.4: Commit the schema change**

```bash
cd /Users/jcarney/Documents/Code-Projects/HAVENHub && git add prisma/schema.prisma prisma/migrations/ && git commit -m "feat(schema): add CertificateSource enum and source field to HipaaCertificate"
```

---

## Task 2: Add `ALL_PEOPLE_ATTACHMENT_FIELDS` constant

**Files:**
- Modify: `src/platform/airtable/fields.ts`

- [ ] **Step 2.1: Add the constant**

Append to the bottom of `src/platform/airtable/fields.ts`:

```ts
/**
 * Attachment fields on All People that are NOT included in ALL_PEOPLE_FIELDS.
 *
 * ALL_PEOPLE_FIELDS doubles as the mirrored text-field set used by
 * personMirrorPayload and MIRRORED_FIELDS in mirror.ts. Adding an attachment
 * field there would corrupt the mirror payload because the mirror only handles
 * scalar text fields. Attachment field IDs must live in this separate constant.
 */
export const ALL_PEOPLE_ATTACHMENT_FIELDS = {
  hipaaCertificate: "fld1k09CQVK2VSIJM",
} as const;
```

- [ ] **Step 2.2: Verify typecheck passes**

```bash
cd /Users/jcarney/Documents/Code-Projects/HAVENHub && npx tsc --noEmit 2>&1 | head -30
```

Expected: no output (zero errors).

- [ ] **Step 2.3: Commit**

```bash
cd /Users/jcarney/Documents/Code-Projects/HAVENHub && git add src/platform/airtable/fields.ts && git commit -m "feat(airtable): export ALL_PEOPLE_ATTACHMENT_FIELDS separate from text field set"
```

---

## Task 3: Write failing tests for `backfillCertificates` (TDD red phase)

**Files:**
- Create: `src/platform/airtable/import/certificates.test.ts`

- [ ] **Step 3.1: Create the test file**

Create `src/platform/airtable/import/certificates.test.ts` with the following content:

```ts
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
    const person = await createPerson({ airtableRecordId: "recDave" });

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
```

- [ ] **Step 3.2: Run tests to confirm they fail (module not found)**

```bash
cd /Users/jcarney/Documents/Code-Projects/HAVENHub && npx vitest run src/platform/airtable/import/certificates.test.ts 2>&1 | tail -20
```

Expected: FAIL with error like "Cannot find module './certificates'" or similar. If they pass, something is wrong -- stop and investigate.

---

## Task 4: Implement `backfillCertificates` (TDD green phase)

**Files:**
- Create: `src/platform/airtable/import/certificates.ts`

- [ ] **Step 4.1: Create the implementation file**

Create `src/platform/airtable/import/certificates.ts`:

```ts
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
```

- [ ] **Step 4.2: Run the tests to confirm they pass**

```bash
cd /Users/jcarney/Documents/Code-Projects/HAVENHub && npx vitest run src/platform/airtable/import/certificates.test.ts 2>&1 | tail -30
```

Expected: all tests PASS. If any fail, read the error and fix the implementation. Do NOT change the tests unless the spec was wrong.

- [ ] **Step 4.3: Run the full test suite to check for regressions**

```bash
cd /Users/jcarney/Documents/Code-Projects/HAVENHub && npm test 2>&1 | tail -30
```

Expected: all tests pass (originally 311 + the ~9 new ones).

- [ ] **Step 4.4: Commit**

```bash
cd /Users/jcarney/Documents/Code-Projects/HAVENHub && git add src/platform/airtable/import/certificates.ts src/platform/airtable/import/certificates.test.ts && git commit -m "feat(airtable): TDD backfillCertificates -- import HIPAA certs from Airtable attachments"
```

---

## Task 5: CLI script and package.json scripts

**Files:**
- Create: `scripts/import-certificates.ts`
- Modify: `package.json`

- [ ] **Step 5.1: Create the CLI script**

Create `scripts/import-certificates.ts`:

```ts
// Live HIPAA certificate backfill from Airtable "All People" attachments.
// Dry-run by default:
//   npx tsx --env-file=.env scripts/import-certificates.ts
//   npx tsx --env-file=.env scripts/import-certificates.ts --apply
import { config } from "@/platform/config";
import { AirtableClient } from "@/platform/airtable/client";
import { backfillCertificates } from "@/platform/airtable/import/certificates";

async function download(url: string): Promise<Buffer> {
  // Airtable attachment URLs are public-expiring signed URLs -- no auth header needed.
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Download failed: ${res.status} ${res.statusText} for ${url}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

async function main() {
  if (!config.AIRTABLE_PAT) {
    console.error("AIRTABLE_PAT is not set in .env; the backfill needs read access.");
    process.exit(1);
  }

  const dryRun = !process.argv.includes("--apply");
  const client = new AirtableClient(config.AIRTABLE_PAT);

  console.log(dryRun ? "Dry run -- no changes will be written." : "Apply mode -- writing to database and disk.");
  console.log();

  const report = await backfillCertificates(client, download, {
    baseId: config.HAVEN_MGMT_BASE_ID,
    peopleTableId: config.ALL_PEOPLE_TABLE_ID,
    dryRun,
  });

  console.log(JSON.stringify(report, null, 2));

  if (dryRun) {
    console.log("\nDry run only. Re-run with --apply to write.");
  }

  if (report.failures.length > 0) {
    console.log(`\n${report.failures.length} failure(s):`);
    for (const f of report.failures) {
      console.log(`  ${f.recordId}: ${f.reason}`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 5.2: Add scripts to package.json**

In `package.json`, add inside the `"scripts"` block (after the existing `"import:apply"` line):

```json
"import:certs:dry": "tsx --env-file=.env scripts/import-certificates.ts",
"import:certs:apply": "tsx --env-file=.env scripts/import-certificates.ts --apply",
```

- [ ] **Step 5.3: Verify typecheck still passes**

```bash
cd /Users/jcarney/Documents/Code-Projects/HAVENHub && npx tsc --noEmit 2>&1 | head -30
```

Expected: no output (zero errors).

- [ ] **Step 5.4: Commit**

```bash
cd /Users/jcarney/Documents/Code-Projects/HAVENHub && git add scripts/import-certificates.ts package.json && git commit -m "feat(scripts): import-certificates CLI with dry-run default and --apply flag"
```

---

## Task 6: UI tweak -- distinguish imported certs in HipaaPanel

**Files:**
- Modify: `src/modules/my-info/components/hipaa-panel.tsx`

The `listMyCertificates` query already returns full rows including `source`. No service layer change needed.

- [ ] **Step 6.1: Update the HipaaPanel component**

In `src/modules/my-info/components/hipaa-panel.tsx`, replace the `formatDate` usage in the "Current Certificate" section to conditionally show the import label.

Replace the current certificate display paragraph:

```tsx
{latest ? (
  <p className="text-sm text-slate-600">
    Uploaded {formatDate(latest.uploadedAt)}{" "}
    <Link
      href={`/my-info/certificate/${latest.id}`}
      className="text-brand hover:underline"
    >
      Download
    </Link>
  </p>
) : (
```

With:

```tsx
{latest ? (
  <p className="text-sm text-slate-600">
    {latest.source === "IMPORT"
      ? "On file (imported from previous records)"
      : `Uploaded ${formatDate(latest.uploadedAt)}`}{" "}
    <Link
      href={`/my-info/certificate/${latest.id}`}
      className="text-brand hover:underline"
    >
      Download
    </Link>
  </p>
) : (
```

Also update each history item's date display. Replace:

```tsx
<span>{formatDate(cert.uploadedAt)}</span>
```

With:

```tsx
<span>
  {cert.source === "IMPORT"
    ? "On file (imported from previous records)"
    : formatDate(cert.uploadedAt)}
</span>
```

- [ ] **Step 6.2: Verify typecheck passes**

```bash
cd /Users/jcarney/Documents/Code-Projects/HAVENHub && npx tsc --noEmit 2>&1 | head -30
```

Expected: no output (zero errors). If TypeScript does not know about `source` on `HipaaCertificate`, run `npx prisma generate` first.

- [ ] **Step 6.3: Commit**

```bash
cd /Users/jcarney/Documents/Code-Projects/HAVENHub && git add src/modules/my-info/components/hipaa-panel.tsx && git commit -m "feat(my-info): show distinct label for imported HIPAA certs in HipaaPanel"
```

---

## Task 7: Gauntlet -- full test, typecheck, lint, e2e

- [ ] **Step 7.1: Full test suite**

```bash
cd /Users/jcarney/Documents/Code-Projects/HAVENHub && npm test 2>&1 | tail -20
```

Expected: all tests pass.

- [ ] **Step 7.2: Typecheck**

```bash
cd /Users/jcarney/Documents/Code-Projects/HAVENHub && npm run typecheck 2>&1 | head -30
```

Expected: exits 0, no output.

- [ ] **Step 7.3: Lint**

```bash
cd /Users/jcarney/Documents/Code-Projects/HAVENHub && npm run lint 2>&1 | head -30
```

Expected: exits 0, no warnings or errors.

- [ ] **Step 7.4: e2e (kill dev servers first)**

```bash
cd /Users/jcarney/Documents/Code-Projects/HAVENHub && pkill -f "next dev" 2>/dev/null; pkill -f "next start" 2>/dev/null; npm run e2e 2>&1 | tail -20
```

Expected: 16 tests pass.

---

## Task 8: Live run and verification

- [ ] **Step 8.1: Dry run**

```bash
cd /Users/jcarney/Documents/Code-Projects/HAVENHub && npm run import:certs:dry 2>&1
```

Report the counts: imported, skippedExisting, peopleWithoutCerts, failures.

- [ ] **Step 8.2: Apply run**

```bash
cd /Users/jcarney/Documents/Code-Projects/HAVENHub && npm run import:certs:apply 2>&1
```

Expected: imported > 0, no failures (or document any that appear).

- [ ] **Step 8.3: Verify Jack's record in the database**

```bash
psql postgresql://haven:haven_dev@localhost:5434/havenhub -c "
SELECT hc.id, hc.\"fileName\", hc.\"mimeType\", hc.source, hc.\"uploadedAt\", p.\"contactEmail\"
FROM \"HipaaCertificate\" hc
JOIN \"Person\" p ON p.id = hc.\"personId\"
WHERE p.\"contactEmail\" = 'j.carney@yale.edu';
"
```

Expected: at least one row with `source = 'IMPORT'`.

- [ ] **Step 8.4: Commit everything**

```bash
cd /Users/jcarney/Documents/Code-Projects/HAVENHub && git add -p && git commit -m "feat(my-info): backfill existing hipaa certificates from airtable"
```

If all changes are already committed from the task-by-task commits above, this step is a no-op -- verify with `git status` first.

---

## Self-Review Against Spec

| Spec Requirement | Covered |
|---|---|
| `source` enum `CertificateSource { UPLOAD IMPORT }` + `@default(UPLOAD)` | Task 1 |
| Migration named `certificate-source` | Task 1.2 |
| Inspect generated SQL for unexpected DROPs | Task 1.2 (explicit STOP instruction) |
| `test:prepare` for test DB | Task 1.3 |
| `ALL_PEOPLE_ATTACHMENT_FIELDS` constant separate from ALL_PEOPLE_FIELDS | Task 2 |
| Comment explaining why it is separate | Task 2.1 |
| `AttachmentDownloader` type exported | Task 4.1 (type exported) |
| `backfillCertificates` function signature matches spec | Task 4.1 |
| Takes LAST attachment (newest) | Task 4.1 (`atts[atts.length - 1]`) |
| No outbox enqueue | Task 4.1 (no enqueueMirror call) |
| No audit in dry-run | Task 4.1 (continue before audit) |
| One audit per import `my-info.certificate_import` with null actor | Task 4.1 |
| Mime extension mapping (pdf/jpg/png/bin) | Task 4.1 + tests in Task 3 |
| Write-after-commit pattern with cleanup on disk failure | Task 4.1 |
| Dry-run downloads nothing (downloader spy uncalled) | Task 3 test |
| No outbox rows test | Task 3 test |
| CLI mirrors import-airtable.ts pattern | Task 5.1 |
| Dry-run default, `--apply` flag | Task 5.1 |
| PAT check | Task 5.1 |
| Plain fetch for download (no auth headers) | Task 5.1 |
| `import:certs:dry` / `import:certs:apply` scripts | Task 5.2 |
| UI: IMPORT source shows distinct label | Task 6.1 |
| Download links work the same | Task 6.1 (href unchanged) |
| Full npm test, typecheck, lint, e2e | Task 7 |
| Live dry run then apply | Task 8.1-8.2 |
| Jack verification via psql | Task 8.3 |
| Commit message matches spec | Task 8.4 |
