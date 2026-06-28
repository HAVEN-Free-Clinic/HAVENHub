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
const ROSTER_TABLE_ID = "tblRosterTest";

// SU26 roster field IDs
const FLD_DEPT_CODE = "fldBIGmgM2dU0vFUQ"; // Department Name (code)
const FLD_IDEAL_HC = "fldKxrbiiBNty8aHq"; // Ideal Headcount
const FLD_PAT_CAP = "fldYkBnHvszTKUHT0"; // Patient Capacity Per Provider

const BASE_OPTS: Omit<ScheduleConfigImportOptions, "dryRun"> = {
  baseId: BASE_ID,
  rosterTableId: ROSTER_TABLE_ID,
};

// ---------------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------------

async function seedDept(code: string, name: string) {
  return prisma.department.create({ data: { code, name } });
}

// ---------------------------------------------------------------------------
// Fake reader factory: accepts a roster record array
// ---------------------------------------------------------------------------

function makeReader(
  rosterRows: Array<{ id: string; fields: Record<string, unknown> }> = []
): AirtableReader {
  return {
    async listAll(_base: string, table: string) {
      if (table === ROSTER_TABLE_ID) return rosterRows;
      return [];
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runScheduleConfigImport", () => {
  beforeEach(resetDb);

  // -------------------------------------------------------------------------
  // Roster: department config set
  // -------------------------------------------------------------------------

  it("sets idealHeadcount and patientCapacityPerProvider from roster row", async () => {
    const dept = await seedDept("SURG", "Surgery");

    const reader = makeReader([
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

    const reader = makeReader([
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
    const reader = makeReader([
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

    const reader = makeReader([
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
    await seedDept("SURG", "Surgery");

    const reader = makeReader([
      { id: "rowSurg", fields: { [FLD_DEPT_CODE]: "SURG", [FLD_IDEAL_HC]: 4, [FLD_PAT_CAP]: 10 } },
    ]);

    const first = await runScheduleConfigImport(reader, { ...BASE_OPTS, dryRun: false });
    expect(first.deptConfigChanged).toBe(1);

    const second = await runScheduleConfigImport(reader, { ...BASE_OPTS, dryRun: false });
    expect(second.deptConfigChanged).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Dry run: no writes
  // -------------------------------------------------------------------------

  it("dry run counts changes without writing to the database", async () => {
    await seedDept("SURG", "Surgery");

    const reader = makeReader([
      { id: "rowSurg", fields: { [FLD_DEPT_CODE]: "SURG", [FLD_IDEAL_HC]: 4, [FLD_PAT_CAP]: 10 } },
    ]);

    const report = await runScheduleConfigImport(reader, { ...BASE_OPTS, dryRun: true });
    expect(report.deptConfigChanged).toBe(1);

    const dept = await prisma.department.findFirst({ where: { code: "SURG" } });
    expect(dept?.idealHeadcount).toBeNull();

    // No audit log
    expect(await prisma.auditLog.count()).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Apply mode writes audit entry
  // -------------------------------------------------------------------------

  it("apply mode writes exactly one schedule.config_import audit entry", async () => {
    const reader = makeReader([
      { id: "rowSurg", fields: { [FLD_DEPT_CODE]: "SURG", [FLD_IDEAL_HC]: 4, [FLD_PAT_CAP]: 10 } },
    ]);
    await seedDept("SURG", "Surgery");

    await runScheduleConfigImport(reader, { ...BASE_OPTS, dryRun: false });

    const audit = await prisma.auditLog.findFirst({ where: { action: "schedule.config_import" } });
    expect(audit).not.toBeNull();
    expect(audit!.actorPersonId).toBeNull();
    const after = audit!.after as Record<string, unknown>;
    expect(after.deptConfigChanged).toBe(1);
  });

  // -------------------------------------------------------------------------
  // Report shape
  // -------------------------------------------------------------------------

  it("report contains all expected keys", async () => {
    const reader = makeReader([]);
    const report = await runScheduleConfigImport(reader, { ...BASE_OPTS, dryRun: false });
    expect(report).toMatchObject({
      rosterRowsScanned: expect.any(Number),
      deptConfigChanged: expect.any(Number),
      unknownDepartments: expect.any(Array),
    });
  });
});
