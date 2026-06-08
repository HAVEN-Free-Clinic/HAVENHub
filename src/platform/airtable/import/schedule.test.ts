/**
 * Integration tests for runScheduleImport.
 *
 * Uses the real test database (resetDb) and a FakeReader pattern mirroring
 * importer.test.ts. No real Airtable calls are made.
 *
 * NOTE: AirtableClient.listAll requests returnFieldsByFieldId=true, so all
 * fixture `fields` objects below are keyed by real Airtable field IDs (e.g.
 * "fldRqPKWn6NxzoJXZ"), not display names.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { runScheduleImport, type ScheduleImportOptions } from "./schedule";
import type { AirtableReader } from "./importer";

// ---------------------------------------------------------------------------
// Test data constants
// ---------------------------------------------------------------------------

const BASE_ID = "appTest";
const TABLE_ID = "tblTest";
const TERM_CODE = "SU26";

// Airtable record ids for fake people
const REC_ALICE = "recAlice";
const REC_BOB = "recBob";
const REC_CAROL = "recCarol";
const REC_DAN = "recDan";
const REC_GHOST = "recGhost"; // intentionally never seeded in DB

// Clinic date we will use: 2026-06-15 at noon UTC
const CLINIC_DATE = new Date("2026-06-15T12:00:00Z");
const CLINIC_DATE_STR = "2026-06-15";

// Non-clinic date: not in clinicDates
const OTHER_DATE_STR = "2026-07-04";

const DEPT_NAME = "Surgery";
const DEPT_CODE = "SURGERY"; // seedDept uses name.toUpperCase() for the code

// Default options
const BASE_OPTS: Omit<ScheduleImportOptions, "dryRun"> = {
  baseId: BASE_ID,
  scheduleTableId: TABLE_ID,
  termCode: TERM_CODE,
};

// ---------------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------------

async function seedTerm() {
  return prisma.term.create({
    data: {
      code: TERM_CODE,
      name: "Summer 2026",
      startDate: new Date("2026-05-30T12:00:00Z"),
      endDate: new Date("2026-09-26T12:00:00Z"),
      status: "ACTIVE",
      clinicDates: [CLINIC_DATE],
    },
  });
}

async function seedDept(name = DEPT_NAME) {
  return prisma.department.create({
    data: { code: name.toUpperCase(), name },
  });
}

async function seedPerson(name: string, airtableRecordId: string) {
  return prisma.person.create({
    data: { name, airtableRecordId },
  });
}

// ---------------------------------------------------------------------------
// Fake reader factory
// ---------------------------------------------------------------------------

function makeReader(rows: Array<{ id: string; fields: Record<string, unknown> }>): AirtableReader {
  return {
    async listAll(_base: string, _table: string) {
      return rows;
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runScheduleImport", () => {
  beforeEach(resetDb);

  // -------------------------------------------------------------------------
  // Basic role splitting and tags
  // -------------------------------------------------------------------------

  it("splits roles: director lands as DIRECTOR, volunteer as VOLUNTEER", async () => {
    await seedTerm();
    await seedDept();
    const alice = await seedPerson("Alice", REC_ALICE);
    const bob = await seedPerson("Bob", REC_BOB);

    const reader = makeReader([
      {
        id: "rowX",
        fields: {
          "fldBdcAE6F8Bqu4FW": [DEPT_CODE],
          "fldRqPKWn6NxzoJXZ": CLINIC_DATE_STR,
          "fldWECXlelGfP9Sb0": [REC_ALICE],
          "fldMoCbSA44uhyjxx": [REC_BOB],
          "fldqFDr9lu1Ih4YC0": [],
          "fldvZalLmfRQijopm": [],
          "fldmQasTpGxocBz9l": [],
          "fldepAQbnkNquxSYd": [],
          "fldxyf4junebaIIYQ": [],
        },
      },
    ]);

    const report = await runScheduleImport(reader, { ...BASE_OPTS, dryRun: false });
    expect(report.created).toBe(2);
    expect(report.updated).toBe(0);
    expect(report.unresolvedPeople).toHaveLength(0);

    const assignments = await prisma.shiftAssignment.findMany({ orderBy: { role: "asc" } });
    expect(assignments).toHaveLength(2);

    const dir = assignments.find((a) => a.personId === alice.id);
    expect(dir?.role).toBe("DIRECTOR");

    const vol = assignments.find((a) => a.personId === bob.id);
    expect(vol?.role).toBe("VOLUNTEER");
  });

  it("shadow volunteers land as SHADOW", async () => {
    await seedTerm();
    await seedDept();
    const carol = await seedPerson("Carol", REC_CAROL);

    const reader = makeReader([
      {
        id: "rowShadow",
        fields: {
          "fldBdcAE6F8Bqu4FW": [DEPT_CODE],
          "fldRqPKWn6NxzoJXZ": CLINIC_DATE_STR,
          "fldWECXlelGfP9Sb0": [],
          "fldMoCbSA44uhyjxx": [],
          "fldqFDr9lu1Ih4YC0": [REC_CAROL],
          "fldvZalLmfRQijopm": [],
          "fldmQasTpGxocBz9l": [],
          "fldepAQbnkNquxSYd": [],
          "fldxyf4junebaIIYQ": [],
        },
      },
    ]);

    await runScheduleImport(reader, { ...BASE_OPTS, dryRun: false });

    const a = await prisma.shiftAssignment.findFirst({ where: { personId: carol.id } });
    expect(a?.role).toBe("SHADOW");
  });

  it("tags land on the correct VOLUNTEER row", async () => {
    await seedTerm();
    await seedDept();
    const bob = await seedPerson("Bob", REC_BOB);

    const reader = makeReader([
      {
        id: "rowTags",
        fields: {
          "fldBdcAE6F8Bqu4FW": [DEPT_CODE],
          "fldRqPKWn6NxzoJXZ": CLINIC_DATE_STR,
          "fldWECXlelGfP9Sb0": [],
          "fldMoCbSA44uhyjxx": [REC_BOB],
          "fldqFDr9lu1Ih4YC0": [],
          "fldvZalLmfRQijopm": [REC_BOB],
          "fldmQasTpGxocBz9l": [REC_BOB],
          "fldepAQbnkNquxSYd": [],
          "fldxyf4junebaIIYQ": [],
        },
      },
    ]);

    await runScheduleImport(reader, { ...BASE_OPTS, dryRun: false });

    const a = await prisma.shiftAssignment.findFirst({ where: { personId: bob.id } });
    expect(a?.role).toBe("VOLUNTEER");
    expect(a?.triage).toBe(true);
    expect(a?.remote).toBe(true);
    expect(a?.walkin).toBe(false);
    expect(a?.cc).toBe(false);
  });

  it("tag-implies-on-shift: a triage person not in volunteers list gets a VOLUNTEER row", async () => {
    await seedTerm();
    await seedDept();
    const carol = await seedPerson("Carol", REC_CAROL);

    const reader = makeReader([
      {
        id: "rowTagOnShift",
        fields: {
          "fldBdcAE6F8Bqu4FW": [DEPT_CODE],
          "fldRqPKWn6NxzoJXZ": CLINIC_DATE_STR,
          "fldWECXlelGfP9Sb0": [],
          "fldMoCbSA44uhyjxx": [],
          "fldqFDr9lu1Ih4YC0": [],
          "fldvZalLmfRQijopm": [],
          "fldmQasTpGxocBz9l": [REC_CAROL],
          "fldepAQbnkNquxSYd": [],
          "fldxyf4junebaIIYQ": [],
        },
      },
    ]);

    const report = await runScheduleImport(reader, { ...BASE_OPTS, dryRun: false });
    expect(report.created).toBe(1);

    const a = await prisma.shiftAssignment.findFirst({ where: { personId: carol.id } });
    expect(a?.role).toBe("VOLUNTEER");
    expect(a?.triage).toBe(true);
  });

  it("director+volunteer duplicate: DIRECTOR is kept, volunteer slot not double-counted", async () => {
    await seedTerm();
    await seedDept();
    const alice = await seedPerson("Alice", REC_ALICE);

    const reader = makeReader([
      {
        id: "rowDirVol",
        fields: {
          "fldBdcAE6F8Bqu4FW": [DEPT_CODE],
          "fldRqPKWn6NxzoJXZ": CLINIC_DATE_STR,
          "fldWECXlelGfP9Sb0": [REC_ALICE],
          "fldMoCbSA44uhyjxx": [REC_ALICE], // same person in both lists
          "fldqFDr9lu1Ih4YC0": [],
          "fldvZalLmfRQijopm": [],
          "fldmQasTpGxocBz9l": [],
          "fldepAQbnkNquxSYd": [],
          "fldxyf4junebaIIYQ": [],
        },
      },
    ]);

    const report = await runScheduleImport(reader, { ...BASE_OPTS, dryRun: false });
    // Only 1 assignment created (DIRECTOR wins; VOLUNTEER duplicate dropped)
    expect(report.created).toBe(1);

    const assignments = await prisma.shiftAssignment.findMany({ where: { personId: alice.id } });
    expect(assignments).toHaveLength(1);
    expect(assignments[0].role).toBe("DIRECTOR");
  });

  it("director also in triage: one DIRECTOR row with triage=true, no extra VOLUNTEER row", async () => {
    await seedTerm();
    await seedDept();
    const alice = await seedPerson("Alice", REC_ALICE);

    const reader = makeReader([
      {
        id: "rowDirTriage",
        fields: {
          "fldBdcAE6F8Bqu4FW": [DEPT_CODE],
          "fldRqPKWn6NxzoJXZ": CLINIC_DATE_STR,
          "fldWECXlelGfP9Sb0": [REC_ALICE],
          "fldMoCbSA44uhyjxx": [],
          "fldqFDr9lu1Ih4YC0": [],
          "fldvZalLmfRQijopm": [],
          "fldmQasTpGxocBz9l": [REC_ALICE], // same person also tagged
          "fldepAQbnkNquxSYd": [],
          "fldxyf4junebaIIYQ": [],
        },
      },
    ]);

    const report = await runScheduleImport(reader, { ...BASE_OPTS, dryRun: false });
    // Exactly one assignment created (no extra VOLUNTEER row for the tag)
    expect(report.created).toBe(1);

    const assignments = await prisma.shiftAssignment.findMany({ where: { personId: alice.id } });
    expect(assignments).toHaveLength(1);
    expect(assignments[0].role).toBe("DIRECTOR");
    expect(assignments[0].triage).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Unresolved people
  // -------------------------------------------------------------------------

  it("unresolved person id generates a report entry; rest of row still imports", async () => {
    await seedTerm();
    await seedDept();
    const alice = await seedPerson("Alice", REC_ALICE);

    const reader = makeReader([
      {
        id: "rowUnresolved",
        fields: {
          "fldBdcAE6F8Bqu4FW": [DEPT_CODE],
          "fldRqPKWn6NxzoJXZ": CLINIC_DATE_STR,
          "fldWECXlelGfP9Sb0": [REC_ALICE],
          "fldMoCbSA44uhyjxx": [REC_GHOST], // ghost: not in DB
          "fldqFDr9lu1Ih4YC0": [],
          "fldvZalLmfRQijopm": [],
          "fldmQasTpGxocBz9l": [],
          "fldepAQbnkNquxSYd": [],
          "fldxyf4junebaIIYQ": [],
        },
      },
    ]);

    const report = await runScheduleImport(reader, { ...BASE_OPTS, dryRun: false });
    expect(report.unresolvedPeople).toHaveLength(1);
    expect(report.unresolvedPeople[0]).toMatchObject({ rowId: "rowUnresolved", recordId: REC_GHOST });

    // Alice still imported
    expect(report.created).toBe(1);
    const a = await prisma.shiftAssignment.findFirst({ where: { personId: alice.id } });
    expect(a?.role).toBe("DIRECTOR");
  });

  // -------------------------------------------------------------------------
  // Non-clinic date rows
  // -------------------------------------------------------------------------

  it("non-clinic date row is added to skippedDates and the row is skipped", async () => {
    await seedTerm();
    await seedDept();
    await seedPerson("Alice", REC_ALICE);

    const reader = makeReader([
      {
        id: "rowBadDate",
        fields: {
          "fldBdcAE6F8Bqu4FW": [DEPT_CODE],
          "fldRqPKWn6NxzoJXZ": OTHER_DATE_STR,
          "fldWECXlelGfP9Sb0": [REC_ALICE],
          "fldMoCbSA44uhyjxx": [],
          "fldqFDr9lu1Ih4YC0": [],
          "fldvZalLmfRQijopm": [],
          "fldmQasTpGxocBz9l": [],
          "fldepAQbnkNquxSYd": [],
          "fldxyf4junebaIIYQ": [],
        },
      },
    ]);

    const report = await runScheduleImport(reader, { ...BASE_OPTS, dryRun: false });
    expect(report.skippedDates).toContain(OTHER_DATE_STR);
    expect(report.created).toBe(0);
    expect(await prisma.shiftAssignment.count()).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Unknown department name
  // -------------------------------------------------------------------------

  it("unknown department code is collected in unknownDepartments and row is skipped", async () => {
    await seedTerm();
    await seedDept(); // seeds "Surgery" / code "SURGERY"
    await seedPerson("Alice", REC_ALICE);

    const reader = makeReader([
      {
        id: "rowUnknownDept",
        fields: {
          "fldBdcAE6F8Bqu4FW": ["RADIOLOGY"], // code not seeded
          "fldRqPKWn6NxzoJXZ": CLINIC_DATE_STR,
          "fldWECXlelGfP9Sb0": [REC_ALICE],
          "fldMoCbSA44uhyjxx": [],
          "fldqFDr9lu1Ih4YC0": [],
          "fldvZalLmfRQijopm": [],
          "fldmQasTpGxocBz9l": [],
          "fldepAQbnkNquxSYd": [],
          "fldxyf4junebaIIYQ": [],
        },
      },
    ]);

    const report = await runScheduleImport(reader, { ...BASE_OPTS, dryRun: false });
    expect(report.unknownDepartments).toContain("RADIOLOGY");
    expect(report.created).toBe(0);
    expect(await prisma.shiftAssignment.count()).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Idempotency
  // -------------------------------------------------------------------------

  it("second apply run produces all unchanged, zero created/updated", async () => {
    await seedTerm();
    await seedDept();
    await seedPerson("Alice", REC_ALICE);
    await seedPerson("Bob", REC_BOB);

    const reader = makeReader([
      {
        id: "rowIdem",
        fields: {
          "fldBdcAE6F8Bqu4FW": [DEPT_CODE],
          "fldRqPKWn6NxzoJXZ": CLINIC_DATE_STR,
          "fldWECXlelGfP9Sb0": [REC_ALICE],
          "fldMoCbSA44uhyjxx": [REC_BOB],
          "fldqFDr9lu1Ih4YC0": [],
          "fldvZalLmfRQijopm": [],
          "fldmQasTpGxocBz9l": [],
          "fldepAQbnkNquxSYd": [],
          "fldxyf4junebaIIYQ": [],
        },
      },
    ]);

    const first = await runScheduleImport(reader, { ...BASE_OPTS, dryRun: false });
    expect(first.created).toBe(2);

    const second = await runScheduleImport(reader, { ...BASE_OPTS, dryRun: false });
    expect(second.created).toBe(0);
    expect(second.updated).toBe(0);
    expect(second.unchanged).toBe(2);
  });

  // -------------------------------------------------------------------------
  // Update path
  // -------------------------------------------------------------------------

  it("a tag flip on the source updates the existing row (updated count 1)", async () => {
    await seedTerm();
    await seedDept();
    const bob = await seedPerson("Bob", REC_BOB);

    const firstReader = makeReader([
      {
        id: "rowUpdate",
        fields: {
          "fldBdcAE6F8Bqu4FW": [DEPT_CODE],
          "fldRqPKWn6NxzoJXZ": CLINIC_DATE_STR,
          "fldWECXlelGfP9Sb0": [],
          "fldMoCbSA44uhyjxx": [REC_BOB],
          "fldqFDr9lu1Ih4YC0": [],
          "fldvZalLmfRQijopm": [],
          "fldmQasTpGxocBz9l": [],
          "fldepAQbnkNquxSYd": [],
          "fldxyf4junebaIIYQ": [],
        },
      },
    ]);

    await runScheduleImport(firstReader, { ...BASE_OPTS, dryRun: false });

    const before = await prisma.shiftAssignment.findFirst({ where: { personId: bob.id } });
    expect(before?.triage).toBe(false);

    // Flip triage on
    const secondReader = makeReader([
      {
        id: "rowUpdate",
        fields: {
          "fldBdcAE6F8Bqu4FW": [DEPT_CODE],
          "fldRqPKWn6NxzoJXZ": CLINIC_DATE_STR,
          "fldWECXlelGfP9Sb0": [],
          "fldMoCbSA44uhyjxx": [REC_BOB],
          "fldqFDr9lu1Ih4YC0": [],
          "fldvZalLmfRQijopm": [],
          "fldmQasTpGxocBz9l": [REC_BOB],
          "fldepAQbnkNquxSYd": [],
          "fldxyf4junebaIIYQ": [],
        },
      },
    ]);

    const second = await runScheduleImport(secondReader, { ...BASE_OPTS, dryRun: false });
    expect(second.updated).toBe(1);
    expect(second.created).toBe(0);

    const after = await prisma.shiftAssignment.findFirst({ where: { personId: bob.id } });
    expect(after?.triage).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Dry run
  // -------------------------------------------------------------------------

  it("dry run: counts are computed but no DB writes occur", async () => {
    await seedTerm();
    await seedDept();
    await seedPerson("Alice", REC_ALICE);
    await seedPerson("Bob", REC_BOB);

    const reader = makeReader([
      {
        id: "rowDry",
        fields: {
          "fldBdcAE6F8Bqu4FW": [DEPT_CODE],
          "fldRqPKWn6NxzoJXZ": CLINIC_DATE_STR,
          "fldWECXlelGfP9Sb0": [REC_ALICE],
          "fldMoCbSA44uhyjxx": [REC_BOB],
          "fldqFDr9lu1Ih4YC0": [],
          "fldvZalLmfRQijopm": [],
          "fldmQasTpGxocBz9l": [],
          "fldepAQbnkNquxSYd": [],
          "fldxyf4junebaIIYQ": [],
        },
      },
    ]);

    const report = await runScheduleImport(reader, { ...BASE_OPTS, dryRun: true });
    expect(report.created).toBe(2);
    expect(report.updated).toBe(0);

    // No rows written
    expect(await prisma.shiftAssignment.count()).toBe(0);
    // No audit log written
    expect(await prisma.auditLog.count()).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Missing term
  // -------------------------------------------------------------------------

  it("throws a clear error when the term is missing", async () => {
    const reader = makeReader([]);

    await expect(
      runScheduleImport(reader, { ...BASE_OPTS, termCode: "MISSING99", dryRun: false })
    ).rejects.toThrow(/MISSING99/);
  });

  // -------------------------------------------------------------------------
  // Audit log in apply mode
  // -------------------------------------------------------------------------

  it("apply mode writes exactly one schedule.import audit entry", async () => {
    await seedTerm();
    await seedDept();
    await seedPerson("Alice", REC_ALICE);

    const reader = makeReader([
      {
        id: "rowAudit",
        fields: {
          "fldBdcAE6F8Bqu4FW": [DEPT_CODE],
          "fldRqPKWn6NxzoJXZ": CLINIC_DATE_STR,
          "fldWECXlelGfP9Sb0": [REC_ALICE],
          "fldMoCbSA44uhyjxx": [],
          "fldqFDr9lu1Ih4YC0": [],
          "fldvZalLmfRQijopm": [],
          "fldmQasTpGxocBz9l": [],
          "fldepAQbnkNquxSYd": [],
          "fldxyf4junebaIIYQ": [],
        },
      },
    ]);

    await runScheduleImport(reader, { ...BASE_OPTS, dryRun: false });

    const audit = await prisma.auditLog.findFirst({ where: { action: "schedule.import" } });
    expect(audit).not.toBeNull();
    expect(audit!.actorPersonId).toBeNull();
    expect(audit!.entityType).toBe("ShiftAssignment");
    expect(audit!.entityId).toBeNull();
    const after = audit!.after as Record<string, unknown>;
    expect(after.created).toBe(1);
  });

  // -------------------------------------------------------------------------
  // Cross-delegation edge: two rows for different departments on same date
  // -------------------------------------------------------------------------

  it("handles multiple departments and dates independently", async () => {
    const secondDate = new Date("2026-06-22T12:00:00Z");
    await prisma.term.create({
      data: {
        code: TERM_CODE,
        name: "Summer 2026",
        startDate: new Date("2026-05-30T12:00:00Z"),
        endDate: new Date("2026-09-26T12:00:00Z"),
        status: "ACTIVE",
        clinicDates: [CLINIC_DATE, secondDate],
      },
    });
    const deptA = await seedDept("Alpha");
    const deptB = await seedDept("Beta");
    const alice = await seedPerson("Alice", REC_ALICE);
    const bob = await seedPerson("Bob", REC_BOB);

    const reader = makeReader([
      {
        id: "rowA",
        fields: {
          "fldBdcAE6F8Bqu4FW": ["ALPHA"], // department code (seedDept("Alpha") produces code "ALPHA")
          "fldRqPKWn6NxzoJXZ": "2026-06-15",
          "fldWECXlelGfP9Sb0": [REC_ALICE],
          "fldMoCbSA44uhyjxx": [],
          "fldqFDr9lu1Ih4YC0": [],
          "fldvZalLmfRQijopm": [],
          "fldmQasTpGxocBz9l": [],
          "fldepAQbnkNquxSYd": [],
          "fldxyf4junebaIIYQ": [],
        },
      },
      {
        id: "rowB",
        fields: {
          "fldBdcAE6F8Bqu4FW": ["BETA"], // department code (seedDept("Beta") produces code "BETA")
          "fldRqPKWn6NxzoJXZ": "2026-06-22",
          "fldWECXlelGfP9Sb0": [REC_BOB],
          "fldMoCbSA44uhyjxx": [],
          "fldqFDr9lu1Ih4YC0": [],
          "fldvZalLmfRQijopm": [],
          "fldmQasTpGxocBz9l": [],
          "fldepAQbnkNquxSYd": [],
          "fldxyf4junebaIIYQ": [],
        },
      },
    ]);

    const report = await runScheduleImport(reader, { ...BASE_OPTS, dryRun: false });
    expect(report.created).toBe(2);

    const aAssign = await prisma.shiftAssignment.findFirst({ where: { departmentId: deptA.id } });
    expect(aAssign?.personId).toBe(alice.id);

    const bAssign = await prisma.shiftAssignment.findFirst({ where: { departmentId: deptB.id } });
    expect(bAssign?.personId).toBe(bob.id);
  });
});
