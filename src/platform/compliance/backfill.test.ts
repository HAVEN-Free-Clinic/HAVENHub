/**
 * TDD tests for backfillCompletionDates and parseAirtableDateText.
 *
 * All DB-touching tests reset via resetDb. Fakes are injected through deps.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { backfillCompletionDates, parseAirtableDateText, type BackfillDeps } from "./backfill";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function createPerson(name: string, airtableRecordId?: string) {
  return prisma.person.create({ data: { name, airtableRecordId } });
}

async function createCert(
  personId: string,
  opts: { mimeType?: string; storedName?: string; fileName?: string } = {}
) {
  return prisma.hipaaCertificate.create({
    data: {
      personId,
      fileName: opts.fileName ?? "cert.pdf",
      storedName: opts.storedName ?? "stored.pdf",
      size: 1000,
      mimeType: opts.mimeType ?? "application/pdf",
    },
  });
}

const FAKE_DATE = new Date("2025-06-01T12:00:00.000Z");

function makeDeps(overrides: Partial<BackfillDeps> = {}): BackfillDeps {
  return {
    parse: vi.fn().mockResolvedValue(null),
    fetchAirtableDate: vi.fn().mockResolvedValue(null),
    readFile: vi.fn().mockResolvedValue(null),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(resetDb);

// ---------------------------------------------------------------------------
// parseAirtableDateText unit tests (no DB)
// ---------------------------------------------------------------------------

describe("parseAirtableDateText", () => {
  it("parses YYYY-MM-DD", () => {
    const d = parseAirtableDateText("2025-06-01");
    expect(d?.toISOString()).toBe("2025-06-01T12:00:00.000Z");
  });

  it("parses MM/DD/YYYY", () => {
    const d = parseAirtableDateText("06/01/2025");
    expect(d?.toISOString()).toBe("2025-06-01T12:00:00.000Z");
  });

  it("parses Month D, YYYY (full name)", () => {
    const d = parseAirtableDateText("June 1, 2025");
    expect(d?.toISOString()).toBe("2025-06-01T12:00:00.000Z");
  });

  it("parses abbreviated month name", () => {
    const d = parseAirtableDateText("Jan 15, 2025");
    expect(d?.toISOString()).toBe("2025-01-15T12:00:00.000Z");
  });

  it("rejects future dates", () => {
    const future = new Date();
    future.setFullYear(future.getFullYear() + 1);
    const iso = future.toISOString().slice(0, 10);
    expect(parseAirtableDateText(iso)).toBeNull();
  });

  it("rejects dates older than 5 years", () => {
    expect(parseAirtableDateText("2010-01-01")).toBeNull();
  });

  it("returns null for unparseable text", () => {
    expect(parseAirtableDateText("not a date at all")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(parseAirtableDateText("")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// backfillCompletionDates integration tests
// ---------------------------------------------------------------------------

describe("backfillCompletionDates", () => {
  it("PDF-parsed path: sets PARSED extraction and writes to DB in apply mode", async () => {
    const person = await createPerson("Alice");
    const cert = await createCert(person.id, { storedName: "alice.pdf" });

    const fakePdfBytes = Buffer.from("fake");
    const deps = makeDeps({
      readFile: vi.fn().mockResolvedValue(fakePdfBytes),
      parse: vi.fn().mockResolvedValue({ date: FAKE_DATE, matchedText: "June 1, 2025" }),
    });

    const result = await backfillCompletionDates(deps, { dryRun: false });

    expect(result.parsed).toBe(1);
    expect(result.airtable).toBe(0);
    expect(result.none).toHaveLength(0);

    const updated = await prisma.hipaaCertificate.findUniqueOrThrow({ where: { id: cert.id } });
    expect(updated.completionDate?.toISOString()).toBe(FAKE_DATE.toISOString());
    expect(updated.extraction).toBe("PARSED");

    // Audit row should exist
    const audit = await prisma.auditLog.findFirst({ where: { action: "compliance.backfill_date", entityId: cert.id } });
    expect(audit).not.toBeNull();
    expect(audit?.actorPersonId).toBeNull();
    expect((audit?.after as Record<string, unknown>)?.extraction).toBe("PARSED");
  });

  it("Airtable fallback path: when PDF parse returns null, falls back to fetchAirtableDate", async () => {
    const person = await createPerson("Bob", "recABC123");
    const cert = await createCert(person.id, { storedName: "bob.pdf" });

    const deps = makeDeps({
      readFile: vi.fn().mockResolvedValue(Buffer.from("fake")),
      parse: vi.fn().mockResolvedValue(null), // PDF parse fails
      fetchAirtableDate: vi.fn().mockResolvedValue("2025-06-01"),
    });

    const result = await backfillCompletionDates(deps, { dryRun: false });

    expect(result.parsed).toBe(0);
    expect(result.airtable).toBe(1);
    expect(result.none).toHaveLength(0);

    const updated = await prisma.hipaaCertificate.findUniqueOrThrow({ where: { id: cert.id } });
    expect(updated.extraction).toBe("AIRTABLE");
    expect(updated.completionDate?.toISOString()).toBe("2025-06-01T12:00:00.000Z");

    const audit = await prisma.auditLog.findFirst({ where: { action: "compliance.backfill_date", entityId: cert.id } });
    expect(audit).not.toBeNull();
    expect((audit?.after as Record<string, unknown>)?.extraction).toBe("AIRTABLE");
  });

  it("Airtable fallback path: non-PDF cert with airtableRecordId fetches Airtable", async () => {
    const person = await createPerson("Carol", "recXYZ999");
    const cert = await createCert(person.id, { storedName: "carol.png", mimeType: "image/png", fileName: "carol.png" });

    const deps = makeDeps({
      fetchAirtableDate: vi.fn().mockResolvedValue("January 15, 2025"),
    });

    const result = await backfillCompletionDates(deps, { dryRun: false });

    expect(result.airtable).toBe(1);
    expect(result.none).toHaveLength(0);

    const updated = await prisma.hipaaCertificate.findUniqueOrThrow({ where: { id: cert.id } });
    expect(updated.extraction).toBe("AIRTABLE");
    expect(updated.completionDate?.toISOString()).toBe("2025-01-15T12:00:00.000Z");
  });

  it("unparseable everything -> none list, no writes", async () => {
    const person = await createPerson("Dave"); // no airtableRecordId
    const cert = await createCert(person.id, { storedName: "dave.pdf" });

    const deps = makeDeps({
      readFile: vi.fn().mockResolvedValue(Buffer.from("fake")),
      parse: vi.fn().mockResolvedValue(null),
      fetchAirtableDate: vi.fn().mockResolvedValue(null),
    });

    const result = await backfillCompletionDates(deps, { dryRun: false });

    expect(result.parsed).toBe(0);
    expect(result.airtable).toBe(0);
    expect(result.none).toHaveLength(1);
    expect(result.none[0].certId).toBe(cert.id);

    const unchanged = await prisma.hipaaCertificate.findUniqueOrThrow({ where: { id: cert.id } });
    expect(unchanged.completionDate).toBeNull();
    expect(unchanged.extraction).toBe("NONE");
  });

  it("image cert with no airtableRecordId lands in none list", async () => {
    const person = await createPerson("Eve"); // no airtableRecordId
    await createCert(person.id, { storedName: "eve.png", mimeType: "image/png", fileName: "eve.png" });

    const deps = makeDeps();

    const result = await backfillCompletionDates(deps, { dryRun: false });

    expect(result.none).toHaveLength(1);
    expect(result.none[0].fileName).toBe("eve.png");
  });

  it("dry-run: counts are correct but no DB writes occur", async () => {
    const person = await createPerson("Frank");
    const cert = await createCert(person.id, { storedName: "frank.pdf" });

    const deps = makeDeps({
      readFile: vi.fn().mockResolvedValue(Buffer.from("fake")),
      parse: vi.fn().mockResolvedValue({ date: FAKE_DATE, matchedText: "June 1, 2025" }),
    });

    const result = await backfillCompletionDates(deps, { dryRun: true });

    expect(result.parsed).toBe(1);

    // No DB write
    const unchanged = await prisma.hipaaCertificate.findUniqueOrThrow({ where: { id: cert.id } });
    expect(unchanged.completionDate).toBeNull();

    // No audit row
    const audit = await prisma.auditLog.findFirst({ where: { action: "compliance.backfill_date" } });
    expect(audit).toBeNull();
  });

  it("apply mode: writes audit rows for each successful extraction", async () => {
    const personA = await createPerson("PersonA");
    const personB = await createPerson("PersonB", "recPB001");
    await createCert(personA.id, { storedName: "a.pdf" });
    await createCert(personB.id, { storedName: "b.png", mimeType: "image/png", fileName: "b.png" });

    const deps = makeDeps({
      readFile: vi.fn().mockResolvedValue(Buffer.from("fake")),
      parse: vi.fn().mockResolvedValue({ date: FAKE_DATE, matchedText: "text" }),
      fetchAirtableDate: vi.fn().mockResolvedValue("2025-06-01"),
    });

    const result = await backfillCompletionDates(deps, { dryRun: false });

    expect(result.parsed).toBe(1);
    expect(result.airtable).toBe(1);
    expect(result.none).toHaveLength(0);

    const audits = await prisma.auditLog.findMany({ where: { action: "compliance.backfill_date" } });
    expect(audits).toHaveLength(2);
  });
});
