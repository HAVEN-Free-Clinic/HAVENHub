/**
 * my-info service tests (TDD).
 *
 * These tests use the real test database and a temp UPLOAD_DIR set in vitest.setup.ts.
 * The UPLOAD_DIR env var must be set before the config module is imported; vitest.setup.ts
 * handles this at process.env level before any module is loaded.
 */

import { beforeEach, describe, expect, it } from "vitest";
import path from "node:path";
import fs from "node:fs/promises";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { config } from "@/platform/config";
import {
  getMyInfo,
  updateMyInfo,
  withdrawFromTerm,
  saveCertificate,
  listMyCertificates,
  parseCertificateUpload,
  CertificateValidationError,
} from "./my-info";

// ---- helpers ----------------------------------------------------------------

async function createPerson(overrides: {
  name?: string;
  netId?: string;
  phone?: string;
  contactEmail?: string;
} = {}) {
  return prisma.person.create({
    data: {
      name: overrides.name ?? "Test Person",
      netId: overrides.netId,
      phone: overrides.phone,
      contactEmail: overrides.contactEmail,
    },
  });
}

async function createTerm(overrides: { status?: "PLANNING" | "ACTIVE" | "ARCHIVED"; code?: string } = {}) {
  const code = overrides.code ?? "SU26";
  return prisma.term.create({
    data: {
      code,
      name: `Summer 2026 ${code}`,
      startDate: new Date("2026-05-01"),
      endDate: new Date("2026-08-31"),
      status: overrides.status ?? "ACTIVE",
    },
  });
}

async function createDepartment(code = "ITCM") {
  return prisma.department.upsert({
    where: { code },
    update: {},
    create: { code, name: `${code} Department` },
  });
}

async function createMembership(
  personId: string,
  termId: string,
  departmentId: string,
  kind: "VOLUNTEER" | "DIRECTOR" = "VOLUNTEER",
  status: "ACTIVE" | "REMOVED" = "ACTIVE"
) {
  return prisma.termMembership.create({
    data: { personId, termId, departmentId, kind, status },
  });
}

/** Minimal valid PDF bytes (1-byte placeholder -- passes mime + extension check). */
function makePdfFile(overrides: {
  name?: string;
  type?: string;
  size?: number;
  bytes?: Buffer;
} = {}) {
  const bytes = overrides.bytes ?? Buffer.from("%PDF-1.4 fake pdf content");
  return {
    name: overrides.name ?? "certificate.pdf",
    type: overrides.type ?? "application/pdf",
    size: overrides.size ?? bytes.length,
    bytes,
  };
}

// ---- setup ------------------------------------------------------------------

beforeEach(async () => {
  await resetDb();
  // Clean the upload dir between tests to avoid leftover files polluting assertions
  try {
    const entries = await fs.readdir(config.UPLOAD_DIR);
    await Promise.all(entries.map((e) => fs.rm(path.join(config.UPLOAD_DIR, e), { force: true })));
  } catch {
    // dir may not exist yet -- that is fine
  }
});

// ---- getMyInfo --------------------------------------------------------------

describe("getMyInfo", () => {
  it("returns the person with active-term ACTIVE memberships and the activeTerm", async () => {
    const person = await createPerson({ name: "Alice", netId: "al001" });
    const term = await createTerm({ status: "ACTIVE" });
    const dept = await createDepartment("ITCM");
    await createMembership(person.id, term.id, dept.id, "VOLUNTEER", "ACTIVE");

    const result = await getMyInfo(person.id);

    expect(result.person.id).toBe(person.id);
    expect(result.memberships).toHaveLength(1);
    expect(result.memberships[0].kind).toBe("VOLUNTEER");
    // activeTerm is returned so the page can use it for the AppShell label
    expect(result.activeTerm?.id).toBe(term.id);
  });

  it("returns null activeTerm when no active term exists", async () => {
    const person = await createPerson();

    const result = await getMyInfo(person.id);

    expect(result.activeTerm).toBeNull();
    expect(result.memberships).toHaveLength(0);
  });

  it("returns only memberships from the active term (not archived)", async () => {
    const person = await createPerson();
    const activeTerm = await createTerm({ status: "ACTIVE", code: "SU26" });
    const archivedTerm = await createTerm({ status: "ARCHIVED", code: "FA25" });
    const dept = await createDepartment("EXEC");
    await createMembership(person.id, activeTerm.id, dept.id, "VOLUNTEER", "ACTIVE");
    await createMembership(person.id, archivedTerm.id, dept.id, "VOLUNTEER", "ACTIVE");

    const result = await getMyInfo(person.id);
    expect(result.memberships.every((m) => m.termId === activeTerm.id)).toBe(true);
  });
});

// ---- updateMyInfo -----------------------------------------------------------

describe("updateMyInfo", () => {
  it("updates only whitelisted fields and ignores smuggled keys like name, netId, and epicId", async () => {
    const person = await createPerson({ name: "Original Name", netId: "orig001" });
    // Pre-set an epicId so we can confirm it is not overwritten.
    await prisma.person.update({ where: { id: person.id }, data: { epicId: "ORIGINAL-EPIC" } });

    // Attempt to smuggle 'name', 'netId', and 'epicId' through the input.
    // Cast to unknown first to bypass TS: the whitelist logic inside the service must strip them.
    const smuggledInput: unknown = {
      phone: "555-1234",
      name: "Hacked Name",
      netId: "hacked",
      epicId: "SMUGGLED-EPIC",
    };
    await updateMyInfo(person.id, smuggledInput as Parameters<typeof updateMyInfo>[1]);

    const updated = await prisma.person.findUniqueOrThrow({ where: { id: person.id } });
    expect(updated.phone).toBe("555-1234");
    expect(updated.name).toBe("Original Name");
    expect(updated.netId).toBe("orig001");
    // epicId must remain unchanged -- it is IT-managed, not self-service
    expect(updated.epicId).toBe("ORIGINAL-EPIC");
  });

  it("delegates to updatePersonFields with self as actor (audit row has actorPersonId === personId)", async () => {
    const person = await createPerson({ name: "Bob" });

    await updateMyInfo(person.id, { phone: "555-9999" });

    const auditRow = await prisma.auditLog.findFirst({
      where: { action: "person.update", entityId: person.id },
      orderBy: { createdAt: "desc" },
    });
    expect(auditRow).not.toBeNull();
    expect(auditRow!.actorPersonId).toBe(person.id);
  });

  it("updates all four whitelisted fields (epicId is not self-service)", async () => {
    const person = await createPerson();
    // Pre-set an epicId to confirm it is untouched even when not passed
    await prisma.person.update({ where: { id: person.id }, data: { epicId: "PRESET-EPIC" } });

    await updateMyInfo(person.id, {
      phone: "203-555-0001",
      contactEmail: "test@example.com",
      yaleAffiliation: "Graduate Student",
      gradYear: "2027",
    });

    const updated = await prisma.person.findUniqueOrThrow({ where: { id: person.id } });
    expect(updated.phone).toBe("203-555-0001");
    expect(updated.contactEmail).toBe("test@example.com");
    expect(updated.yaleAffiliation).toBe("Graduate Student");
    expect(updated.gradYear).toBe("2027");
    // epicId must remain unchanged -- it is IT-managed
    expect(updated.epicId).toBe("PRESET-EPIC");
  });
});

// ---- withdrawFromTerm -------------------------------------------------------

describe("withdrawFromTerm", () => {
  it("sets own ACTIVE VOLUNTEER memberships in the active term to REMOVED and returns count", async () => {
    const person = await createPerson();
    const term = await createTerm({ status: "ACTIVE" });
    const dept1 = await createDepartment("ITCM");
    const dept2 = await createDepartment("EXEC");
    await createMembership(person.id, term.id, dept1.id, "VOLUNTEER", "ACTIVE");
    await createMembership(person.id, term.id, dept2.id, "VOLUNTEER", "ACTIVE");

    const count = await withdrawFromTerm(person.id);

    expect(count).toBe(2);
    const memberships = await prisma.termMembership.findMany({
      where: { personId: person.id, termId: term.id },
    });
    expect(memberships.every((m) => m.status === "REMOVED")).toBe(true);
  });

  it("does not touch DIRECTOR memberships", async () => {
    const person = await createPerson();
    const term = await createTerm({ status: "ACTIVE" });
    const dept = await createDepartment("SRR");
    await createMembership(person.id, term.id, dept.id, "DIRECTOR", "ACTIVE");

    const count = await withdrawFromTerm(person.id);

    expect(count).toBe(0);
    const m = await prisma.termMembership.findFirst({ where: { personId: person.id } });
    expect(m!.status).toBe("ACTIVE");
  });

  it("does not touch memberships in non-active terms", async () => {
    const person = await createPerson();
    const archivedTerm = await createTerm({ status: "ARCHIVED", code: "FA25" });
    const dept = await createDepartment("MENT");
    await createMembership(person.id, archivedTerm.id, dept.id, "VOLUNTEER", "ACTIVE");

    const count = await withdrawFromTerm(person.id);

    expect(count).toBe(0);
    const m = await prisma.termMembership.findFirst({ where: { personId: person.id } });
    expect(m!.status).toBe("ACTIVE");
  });

  it("records an audit row with termId and count when withdrawing", async () => {
    const person = await createPerson();
    const term = await createTerm({ status: "ACTIVE" });
    const dept = await createDepartment("OUTREACH");
    await createMembership(person.id, term.id, dept.id, "VOLUNTEER", "ACTIVE");

    await withdrawFromTerm(person.id);

    const audit = await prisma.auditLog.findFirst({
      where: { action: "my-info.withdraw", actorPersonId: person.id },
    });
    expect(audit).not.toBeNull();
    const after = audit!.after as Record<string, unknown>;
    expect(after.termId).toBe(term.id);
    expect(after.count).toBe(1);
  });

  it("returns 0 and does NOT record an audit row when there are no ACTIVE VOLUNTEER memberships", async () => {
    const person = await createPerson();

    const count = await withdrawFromTerm(person.id);

    expect(count).toBe(0);
    const audit = await prisma.auditLog.findFirst({
      where: { action: "my-info.withdraw", actorPersonId: person.id },
    });
    expect(audit).toBeNull();
  });
});

// ---- saveCertificate --------------------------------------------------------

describe("saveCertificate", () => {
  it("rejects non-pdf mime type with a typed CertificateValidationError", async () => {
    const person = await createPerson();
    const file = makePdfFile({ type: "image/png", name: "cert.pdf" });

    let caught: unknown;
    try {
      await saveCertificate(person.id, file);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(CertificateValidationError);
    expect((caught as CertificateValidationError).reason).toMatch(/mime/i);
  });

  it("rejects a file whose name does not end in .pdf with a typed CertificateValidationError", async () => {
    const person = await createPerson();
    const file = makePdfFile({ name: "malware.exe", type: "application/pdf" });

    let caught: unknown;
    try {
      await saveCertificate(person.id, file);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(CertificateValidationError);
    expect((caught as CertificateValidationError).reason).toMatch(/extension/i);
  });

  it("rejects a file exceeding MAX_UPLOAD_MB with a typed CertificateValidationError", async () => {
    const person = await createPerson();
    const oversizeBytes = config.MAX_UPLOAD_MB * 1024 * 1024 + 1;
    const file = makePdfFile({ size: oversizeBytes, bytes: Buffer.alloc(1, 0) });

    let caught: unknown;
    try {
      await saveCertificate(person.id, file);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(CertificateValidationError);
    expect((caught as CertificateValidationError).reason).toMatch(/size|too large/i);
  });

  it("accepts a pdf whose size is exactly MAX_UPLOAD_MB bytes (boundary)", async () => {
    const person = await createPerson();
    const exactBytes = config.MAX_UPLOAD_MB * 1024 * 1024;
    const file = makePdfFile({ size: exactBytes, bytes: Buffer.alloc(exactBytes, 0x25) });

    const cert = await saveCertificate(person.id, file);

    expect(cert.size).toBe(exactBytes);
  });

  it("accepts a valid pdf: creates the DB row, writes the file to disk, and creates the audit log", async () => {
    const person = await createPerson();
    const file = makePdfFile();

    const cert = await saveCertificate(person.id, file);

    // DB row
    expect(cert.personId).toBe(person.id);
    expect(cert.fileName).toBe("certificate.pdf");
    expect(cert.mimeType).toBe("application/pdf");

    // File on disk at storedName
    const diskPath = path.join(config.UPLOAD_DIR, cert.storedName);
    const diskBytes = await fs.readFile(diskPath);
    expect(diskBytes.equals(file.bytes)).toBe(true);

    // storedName is <cert.id>.pdf
    expect(cert.storedName).toBe(`${cert.id}.pdf`);

    // Audit log
    const audit = await prisma.auditLog.findFirst({
      where: { action: "my-info.certificate_upload", actorPersonId: person.id },
    });
    expect(audit).not.toBeNull();
    const after = audit!.after as Record<string, unknown>;
    expect(after.fileName).toBe("certificate.pdf");
    expect(after.size).toBe(file.bytes.length);
    // bytes must never appear in the audit log
    expect(JSON.stringify(after)).not.toContain("PDF");
  });

  it("cleans up the DB row if the disk write fails (transactional consistency)", async () => {
    const person = await createPerson();
    const file = makePdfFile();

    // Simulate a disk write failure by temporarily making UPLOAD_DIR a path
    // that exists as a FILE (not a directory) so that the mkdir+writeFile will fail.
    // We override the env var and reload config by patching directly.
    const originalUploadDir = config.UPLOAD_DIR;

    // Point UPLOAD_DIR at a path that cannot be used as a directory:
    // create a regular FILE at that path first.
    const badDir = path.join(originalUploadDir, "not-a-dir.txt");
    await fs.mkdir(originalUploadDir, { recursive: true });
    await fs.writeFile(badDir, "I am a file");

    // Temporarily mutate config for this test only
    (config as Record<string, unknown>).UPLOAD_DIR = badDir;

    try {
      await expect(saveCertificate(person.id, file)).rejects.toThrow();
    } finally {
      // Restore config
      (config as Record<string, unknown>).UPLOAD_DIR = originalUploadDir;
      await fs.rm(badDir, { force: true });
    }

    // DB row must be gone
    const certCount = await prisma.hipaaCertificate.count({ where: { personId: person.id } });
    expect(certCount).toBe(0);
  });

  // ---- saveCertificate: parse injection ---------------------------------------

  it("stores completionDate at noon UTC and extraction=PARSED when parse stub returns a date", async () => {
    const person = await createPerson();
    const parsedDate = new Date(Date.UTC(2025, 11, 15, 12, 0, 0, 0)); // 2025-12-15 noon UTC
    const stubParse = async (_bytes: Buffer) => ({ date: parsedDate, matchedText: "12/15/2025" });

    const cert = await saveCertificate(person.id, makePdfFile(), stubParse);

    const row = await prisma.hipaaCertificate.findUniqueOrThrow({ where: { id: cert.id } });
    expect(row.completionDate).toEqual(parsedDate);
    expect(row.extraction).toBe("PARSED");
  });

  it("stores extraction=NONE when parse stub returns null (no date found)", async () => {
    const person = await createPerson();
    const stubParse = async (_bytes: Buffer) => null;

    const cert = await saveCertificate(person.id, makePdfFile(), stubParse);

    const row = await prisma.hipaaCertificate.findUniqueOrThrow({ where: { id: cert.id } });
    expect(row.completionDate).toBeNull();
    expect(row.extraction).toBe("NONE");
  });

  it("upload still succeeds with extraction=NONE when parse stub throws", async () => {
    const person = await createPerson();
    const throwingParse = async (_bytes: Buffer): Promise<{ date: Date; matchedText: string } | null> => {
      throw new Error("PDF is corrupted");
    };

    const cert = await saveCertificate(person.id, makePdfFile(), throwingParse);

    // Upload must succeed despite parser error
    expect(cert.id).toBeTruthy();
    const row = await prisma.hipaaCertificate.findUniqueOrThrow({ where: { id: cert.id } });
    expect(row.completionDate).toBeNull();
    expect(row.extraction).toBe("NONE");
  });

  it("skips parse stub entirely for non-pdf mime (stub is never called)", async () => {
    // non-pdf mime is rejected before parse, so the stub should never be invoked
    // However the current validation rejects non-PDF before getting to parse --
    // demonstrate by using an image mime: the CertificateValidationError fires first.
    const person = await createPerson();
    let called = false;
    const stubParse = async (_bytes: Buffer) => {
      called = true;
      return null;
    };

    const imageFile = makePdfFile({ type: "image/png", name: "cert.pdf" });
    let caught: unknown;
    try {
      await saveCertificate(person.id, imageFile, stubParse);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(CertificateValidationError);
    expect(called).toBe(false); // stub never called because validation fires first
  });
});

// ---- saveCertificate: compliance-manager date-review notification -----------

/** A person who globally holds volunteers.manage_compliance. */
async function createComplianceManager(name = "Cathy Compliance") {
  const person = await prisma.person.create({ data: { name } });
  const role = await prisma.role.create({
    data: {
      name: `Compliance Role ${name}`,
      grants: { create: [{ permission: "volunteers.manage_compliance" }] },
    },
  });
  await prisma.roleAssignment.create({ data: { roleId: role.id, personId: person.id, termId: null } });
  return person;
}

async function countReviewNotifications(): Promise<number> {
  return prisma.notification.count({ where: { type: "compliance-date-review" } });
}

const nullParse = async (_bytes: Buffer) => null;
const dateParse = async (_bytes: Buffer) => ({
  date: new Date(Date.UTC(2026, 0, 10, 12, 0, 0, 0)),
  matchedText: "01/10/2026",
});

describe("saveCertificate compliance-manager notification", () => {
  it("notifies compliance managers when a cert is saved without a parsed date", async () => {
    const manager = await createComplianceManager();
    const volunteer = await createPerson({ name: "Val Volunteer" });

    await saveCertificate(volunteer.id, makePdfFile(), nullParse);

    const notes = await prisma.notification.findMany({ where: { type: "compliance-date-review" } });
    expect(notes.map((n) => n.personId)).toEqual([manager.id]);
  });

  it("does not notify when the completion date parses successfully", async () => {
    await createComplianceManager();
    const volunteer = await createPerson({ name: "Val Volunteer" });

    await saveCertificate(volunteer.id, makePdfFile(), dateParse);

    expect(await countReviewNotifications()).toBe(0);
  });

  it("does not re-notify when the member already has a dateless certificate (dedup)", async () => {
    await createComplianceManager();
    const volunteer = await createPerson({ name: "Val Volunteer" });
    // A pre-existing dateless cert (managers were already alerted when it landed).
    await prisma.hipaaCertificate.create({
      data: {
        personId: volunteer.id,
        fileName: "old.pdf",
        storedName: "old.pdf",
        size: 10,
        mimeType: "application/pdf",
        completionDate: null,
        extraction: "NONE",
        uploadedAt: new Date("2026-01-01T00:00:00Z"),
      },
    });

    await saveCertificate(volunteer.id, makePdfFile(), nullParse);

    expect(await countReviewNotifications()).toBe(0);
  });

  it("notifies again when the member's prior newest cert had a completion date", async () => {
    const manager = await createComplianceManager();
    const volunteer = await createPerson({ name: "Val Volunteer" });
    // A prior, dated cert (e.g. expired); a fresh dateless upload is a new pending case.
    await prisma.hipaaCertificate.create({
      data: {
        personId: volunteer.id,
        fileName: "old.pdf",
        storedName: "old.pdf",
        size: 10,
        mimeType: "application/pdf",
        completionDate: new Date("2024-01-01T12:00:00Z"),
        extraction: "MANUAL",
        uploadedAt: new Date("2026-01-01T00:00:00Z"),
      },
    });

    await saveCertificate(volunteer.id, makePdfFile(), nullParse);

    const notes = await prisma.notification.findMany({ where: { type: "compliance-date-review" } });
    expect(notes.map((n) => n.personId)).toEqual([manager.id]);
  });
});

// ---- listMyCertificates -----------------------------------------------------

describe("listMyCertificates", () => {
  it("returns certificates ordered by uploadedAt descending", async () => {
    const person = await createPerson();

    const first = await prisma.hipaaCertificate.create({
      data: {
        personId: person.id,
        fileName: "old.pdf",
        storedName: "old.pdf",
        size: 100,
        mimeType: "application/pdf",
        uploadedAt: new Date("2026-01-01"),
      },
    });
    const second = await prisma.hipaaCertificate.create({
      data: {
        personId: person.id,
        fileName: "new.pdf",
        storedName: "new.pdf",
        size: 200,
        mimeType: "application/pdf",
        uploadedAt: new Date("2026-06-01"),
      },
    });

    const certs = await listMyCertificates(person.id);

    expect(certs[0].id).toBe(second.id);
    expect(certs[1].id).toBe(first.id);
  });
});

// ---- parseCertificateUpload -------------------------------------------------

describe("parseCertificateUpload", () => {
  it("returns null when the certificate field is missing from FormData", () => {
    const fd = new FormData();
    expect(parseCertificateUpload(fd)).toBeNull();
  });

  it("returns null when the certificate field is a string (not a File)", () => {
    const fd = new FormData();
    fd.set("certificate", "not-a-file");
    expect(parseCertificateUpload(fd)).toBeNull();
  });

  it("returns null when the File is empty (size === 0)", () => {
    const fd = new FormData();
    const emptyFile = new File([], "empty.pdf", { type: "application/pdf" });
    fd.set("certificate", emptyFile);
    expect(parseCertificateUpload(fd)).toBeNull();
  });

  it("returns the parsed fields when a non-empty File is present", () => {
    const fd = new FormData();
    const file = new File(["%PDF-1.4 content"], "cert.pdf", { type: "application/pdf" });
    fd.set("certificate", file);
    const result = parseCertificateUpload(fd);
    expect(result).not.toBeNull();
    expect(result!.name).toBe("cert.pdf");
    expect(result!.type).toBe("application/pdf");
    expect(result!.size).toBeGreaterThan(0);
    expect(result!.file).toBe(file);
  });
});
