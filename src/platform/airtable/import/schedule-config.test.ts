/**
 * Integration tests for runScheduleConfigImport.
 *
 * Uses the real test database (resetDb) and a FakeReader pattern mirroring
 * schedule.test.ts. No real Airtable calls are made.
 *
 * NOTE: AirtableClient.listAll requests returnFieldsByFieldId=true, so all
 * fixture `fields` objects below are keyed by real Airtable field IDs.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { runScheduleConfigImport, type ScheduleConfigImportOptions } from "./schedule-config";
import type { AirtableReader } from "./importer";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BASE_ID = "appTest";
const PEOPLE_TABLE_ID = "tblPeopleTest";
const ROSTER_TABLE_ID = "tblRosterTest";

// Airtable record ids for fake people
const REC_ALICE = "recAlice";
const REC_BOB = "recBob";
const REC_GHOST = "recGhost"; // intentionally never seeded

// All People field IDs (returnFieldsByFieldId=true)
const FLD_SPANISH = "fldU9oI3O8CaB17j1"; // Spanish Speaking checkbox
const FLD_RN = "fld16LPmc7y1gQZ7K"; // Licensed RN checkbox

// SU26 roster field IDs
const FLD_DEPT_CODE = "fldBIGmgM2dU0vFUQ"; // Department Name (code)
const FLD_IDEAL_HC = "fldKxrbiiBNty8aHq"; // Ideal Headcount
const FLD_PAT_CAP = "fldYkBnHvszTKUHT0"; // Patient Capacity Per Provider

const BASE_OPTS: Omit<ScheduleConfigImportOptions, "dryRun"> = {
  baseId: BASE_ID,
  peopleTableId: PEOPLE_TABLE_ID,
  rosterTableId: ROSTER_TABLE_ID,
};

// ---------------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------------

async function seedPerson(
  name: string,
  airtableRecordId: string,
  flags: { spanishSpeaking?: boolean; licensedRN?: boolean } = {}
) {
  return prisma.person.create({
    data: { name, airtableRecordId, ...flags },
  });
}

async function seedDept(code: string, name: string) {
  return prisma.department.create({ data: { code, name } });
}

// ---------------------------------------------------------------------------
// Fake reader factory: accepts two separate record arrays (people, roster)
// ---------------------------------------------------------------------------

function makeReader(
  peopleRows: Array<{ id: string; fields: Record<string, unknown> }>,
  rosterRows: Array<{ id: string; fields: Record<string, unknown> }> = []
): AirtableReader {
  return {
    async listAll(_base: string, table: string) {
      if (table === ROSTER_TABLE_ID) return rosterRows;
      return peopleRows;
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runScheduleConfigImport", () => {
  beforeEach(resetDb);

  // -------------------------------------------------------------------------
  // People: flag set to true
  // -------------------------------------------------------------------------

  it("sets spanishSpeaking=true when checkbox field is present", async () => {
    const alice = await seedPerson("Alice", REC_ALICE, { spanishSpeaking: false });

    const reader = makeReader([
      { id: REC_ALICE, fields: { [FLD_SPANISH]: true } },
    ]);

    const report = await runScheduleConfigImport(reader, { ...BASE_OPTS, dryRun: false });
    expect(report.spanishChanged).toBe(1);
    expect(report.rnChanged).toBe(0);

    const updated = await prisma.person.findUniqueOrThrow({ where: { id: alice.id } });
    expect(updated.spanishSpeaking).toBe(true);
  });

  it("sets licensedRN=true when checkbox field is present", async () => {
    const bob = await seedPerson("Bob", REC_BOB, { licensedRN: false });

    const reader = makeReader([
      { id: REC_BOB, fields: { [FLD_RN]: true } },
    ]);

    const report = await runScheduleConfigImport(reader, { ...BASE_OPTS, dryRun: false });
    expect(report.rnChanged).toBe(1);
    expect(report.spanishChanged).toBe(0);

    const updated = await prisma.person.findUniqueOrThrow({ where: { id: bob.id } });
    expect(updated.licensedRN).toBe(true);
  });

  // -------------------------------------------------------------------------
  // People: flag lowered to false when checkbox absent
  // -------------------------------------------------------------------------

  it("lowers spanishSpeaking to false when field is absent (Airtable is authoritative)", async () => {
    const alice = await seedPerson("Alice", REC_ALICE, { spanishSpeaking: true });

    const reader = makeReader([
      // No FLD_SPANISH field -- checkbox absent means false
      { id: REC_ALICE, fields: {} },
    ]);

    const report = await runScheduleConfigImport(reader, { ...BASE_OPTS, dryRun: false });
    expect(report.spanishChanged).toBe(1);

    const updated = await prisma.person.findUniqueOrThrow({ where: { id: alice.id } });
    expect(updated.spanishSpeaking).toBe(false);
  });

  it("lowers licensedRN to false when field is absent", async () => {
    const bob = await seedPerson("Bob", REC_BOB, { licensedRN: true });

    const reader = makeReader([
      { id: REC_BOB, fields: {} },
    ]);

    const report = await runScheduleConfigImport(reader, { ...BASE_OPTS, dryRun: false });
    expect(report.rnChanged).toBe(1);

    const updated = await prisma.person.findUniqueOrThrow({ where: { id: bob.id } });
    expect(updated.licensedRN).toBe(false);
  });

  // -------------------------------------------------------------------------
  // People: unchanged rows not counted
  // -------------------------------------------------------------------------

  it("unchanged flags produce zero spanishChanged and rnChanged", async () => {
    await seedPerson("Alice", REC_ALICE, { spanishSpeaking: true, licensedRN: false });

    const reader = makeReader([
      { id: REC_ALICE, fields: { [FLD_SPANISH]: true } }, // already true; RN absent -> already false
    ]);

    const report = await runScheduleConfigImport(reader, { ...BASE_OPTS, dryRun: false });
    expect(report.spanishChanged).toBe(0);
    expect(report.rnChanged).toBe(0);
  });

  // -------------------------------------------------------------------------
  // People: unresolved (no matching airtableRecordId)
  // -------------------------------------------------------------------------

  it("counts a row with no matching Person as unresolved", async () => {
    const reader = makeReader([
      { id: REC_GHOST, fields: { [FLD_SPANISH]: true } },
    ]);

    const report = await runScheduleConfigImport(reader, { ...BASE_OPTS, dryRun: false });
    expect(report.peopleUnresolved).toBe(1);
    expect(report.spanishChanged).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Roster: department config set
  // -------------------------------------------------------------------------

  it("sets idealHeadcount and patientCapacityPerProvider from roster row", async () => {
    const dept = await seedDept("SURG", "Surgery");

    const reader = makeReader([], [
      {
        id: "rowSurg",
        fields: {
          [FLD_DEPT_CODE]: "SURG",
          [FLD_IDEAL_HC]: 4,
          [FLD_PAT_CAP]: 10,
        },
      },
    ]);

    const report = await runScheduleConfigImport(reader, { ...BASE_OPTS, dryRun: false });
    expect(report.deptConfigChanged).toBe(1);

    const updated = await prisma.department.findUniqueOrThrow({ where: { id: dept.id } });
    expect(updated.idealHeadcount).toBe(4);
    expect(updated.patientCapacityPerProvider).toBe(10);
  });

  it("sets config to null when roster numbers are absent", async () => {
    const dept = await seedDept("SURG", "Surgery");
    // Pre-set some values
    await prisma.department.update({
      where: { id: dept.id },
      data: { idealHeadcount: 3, patientCapacityPerProvider: 8 },
    });

    const reader = makeReader([], [
      {
        id: "rowSurg",
        fields: {
          [FLD_DEPT_CODE]: "SURG",
          // No headcount or capacity fields -- absent means null
        },
      },
    ]);

    const report = await runScheduleConfigImport(reader, { ...BASE_OPTS, dryRun: false });
    expect(report.deptConfigChanged).toBe(1);

    const updated = await prisma.department.findUniqueOrThrow({ where: { id: dept.id } });
    expect(updated.idealHeadcount).toBeNull();
    expect(updated.patientCapacityPerProvider).toBeNull();
  });

  it("adds unknown department code to unknownDepartments list (deduped)", async () => {
    const reader = makeReader([], [
      { id: "rowA", fields: { [FLD_DEPT_CODE]: "RADIOLOGY", [FLD_IDEAL_HC]: 2, [FLD_PAT_CAP]: 5 } },
      { id: "rowB", fields: { [FLD_DEPT_CODE]: "RADIOLOGY", [FLD_IDEAL_HC]: 2, [FLD_PAT_CAP]: 5 } },
    ]);

    const report = await runScheduleConfigImport(reader, { ...BASE_OPTS, dryRun: false });
    expect(report.unknownDepartments).toHaveLength(1);
    expect(report.unknownDepartments[0]).toBe("RADIOLOGY");
    expect(report.deptConfigChanged).toBe(0);
  });

  it("matches department code case-insensitively", async () => {
    const dept = await seedDept("SURG", "Surgery");

    const reader = makeReader([], [
      { id: "rowSurg", fields: { [FLD_DEPT_CODE]: "surg", [FLD_IDEAL_HC]: 4, [FLD_PAT_CAP]: 10 } },
    ]);

    const report = await runScheduleConfigImport(reader, { ...BASE_OPTS, dryRun: false });
    expect(report.deptConfigChanged).toBe(1);
    expect(report.unknownDepartments).toHaveLength(0);

    const updated = await prisma.department.findUniqueOrThrow({ where: { id: dept.id } });
    expect(updated.idealHeadcount).toBe(4);
  });

  // -------------------------------------------------------------------------
  // Idempotent second run
  // -------------------------------------------------------------------------

  it("second run produces all-zero changes (idempotent)", async () => {
    await seedPerson("Alice", REC_ALICE, { spanishSpeaking: false });
    await seedDept("SURG", "Surgery");

    const reader = makeReader(
      [{ id: REC_ALICE, fields: { [FLD_SPANISH]: true } }],
      [{ id: "rowSurg", fields: { [FLD_DEPT_CODE]: "SURG", [FLD_IDEAL_HC]: 4, [FLD_PAT_CAP]: 10 } }]
    );

    const first = await runScheduleConfigImport(reader, { ...BASE_OPTS, dryRun: false });
    expect(first.spanishChanged).toBe(1);
    expect(first.deptConfigChanged).toBe(1);

    const second = await runScheduleConfigImport(reader, { ...BASE_OPTS, dryRun: false });
    expect(second.spanishChanged).toBe(0);
    expect(second.rnChanged).toBe(0);
    expect(second.deptConfigChanged).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Dry run: no writes
  // -------------------------------------------------------------------------

  it("dry run counts changes without writing to the database", async () => {
    const alice = await seedPerson("Alice", REC_ALICE, { spanishSpeaking: false });
    await seedDept("SURG", "Surgery");

    const reader = makeReader(
      [{ id: REC_ALICE, fields: { [FLD_SPANISH]: true } }],
      [{ id: "rowSurg", fields: { [FLD_DEPT_CODE]: "SURG", [FLD_IDEAL_HC]: 4, [FLD_PAT_CAP]: 10 } }]
    );

    const report = await runScheduleConfigImport(reader, { ...BASE_OPTS, dryRun: true });
    expect(report.spanishChanged).toBe(1);
    expect(report.deptConfigChanged).toBe(1);

    // No actual writes
    const person = await prisma.person.findUniqueOrThrow({ where: { id: alice.id } });
    expect(person.spanishSpeaking).toBe(false);

    const dept = await prisma.department.findFirst({ where: { code: "SURG" } });
    expect(dept?.idealHeadcount).toBeNull();

    // No audit log
    expect(await prisma.auditLog.count()).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Apply mode writes audit entry
  // -------------------------------------------------------------------------

  it("apply mode writes exactly one schedule.config_import audit entry", async () => {
    await seedPerson("Alice", REC_ALICE, { spanishSpeaking: false });

    const reader = makeReader([
      { id: REC_ALICE, fields: { [FLD_SPANISH]: true } },
    ]);

    await runScheduleConfigImport(reader, { ...BASE_OPTS, dryRun: false });

    const audit = await prisma.auditLog.findFirst({ where: { action: "schedule.config_import" } });
    expect(audit).not.toBeNull();
    expect(audit!.actorPersonId).toBeNull();
    expect(audit!.entityType).toBe("Person");
    expect(audit!.entityId).toBeNull();
    const after = audit!.after as Record<string, unknown>;
    expect(after.spanishChanged).toBe(1);
  });

  // -------------------------------------------------------------------------
  // Report shape
  // -------------------------------------------------------------------------

  it("report contains all expected keys", async () => {
    const reader = makeReader([], []);
    const report = await runScheduleConfigImport(reader, { ...BASE_OPTS, dryRun: false });
    expect(report).toMatchObject({
      peopleScanned: expect.any(Number),
      spanishChanged: expect.any(Number),
      rnChanged: expect.any(Number),
      peopleUnresolved: expect.any(Number),
      rosterRowsScanned: expect.any(Number),
      deptConfigChanged: expect.any(Number),
      unknownDepartments: expect.any(Array),
    });
  });
});
