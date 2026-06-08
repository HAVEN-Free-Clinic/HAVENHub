/**
 * Integration tests for runRhdImport and parseClinicDate.
 *
 * Uses the real test database (resetDb) and a FakeReader pattern mirroring
 * schedule.test.ts. No real Airtable calls are made.
 *
 * NOTE: returnFieldsByFieldId=true; all fixture `fields` objects use real field IDs.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { runRhdImport, parseClinicDate, type RhdImportOptions } from "./rhd";
import type { AirtableReader } from "./importer";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BASE_ID = "appTest";
const ATTENDINGS_TABLE = "tblAttendTest";
const CLINICS_TABLE = "tblClinicsTest";
const TERM_CODE = "SU26";

// RHD Attendings field IDs
const FLD_SCHED_NAME = "fld0QTIYF1HHuIqZl"; // Schedule Name
const FLD_FULL_NAME = "fldkejU9lGynjcHwD"; // Full Name
const FLD_IUD_IN = "fldgAtvQsr32XYzHc"; // IUD In
const FLD_IUD_OUT = "fld5CiOguHzJBh44H"; // IUD Out
const FLD_NEXPLANON = "fldJNpizKrDJXlkBq"; // Nexplanon
const FLD_GAC = "fldXmBJdo8mgBUgHT"; // GAC
const FLD_EMB = "fldFLKPjXwZ4FQhVe"; // EMB
const FLD_SEES_MALE = "fld9rxsLC5VZuyaSx"; // Sees Male
const FLD_NOTES = "fldh1FJjByriGBdb0"; // Notes

// RHD Clinics field IDs
const FLD_DATE = "fldfnW6GCdgXwVztA"; // Date
const FLD_ATTENDING_LINK = "fldUVqzqrSU4NTlHx"; // Attending link (array of record ids)
const FLD_DIRECTOR = "fldXCoZq8LKl3a3d2"; // Director on point
const FLD_PROCEDURES = "fldYIWobbtPV90FM5"; // Procedures Booked

// Fake attending Airtable record ids
const REC_DR_JONES = "recDrJones";

// Clinic dates in the term
const CLINIC_DATE_1 = new Date("2026-06-06T12:00:00Z"); // June 6 2026
const CLINIC_DATE_2 = new Date("2026-06-13T12:00:00Z"); // June 13 2026

const BASE_OPTS: Omit<RhdImportOptions, "dryRun"> = {
  baseId: BASE_ID,
  attendingsTableId: ATTENDINGS_TABLE,
  clinicsTableId: CLINICS_TABLE,
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
      clinicDates: [CLINIC_DATE_1, CLINIC_DATE_2],
    },
  });
}

// ---------------------------------------------------------------------------
// Fake reader factory: returns attending rows for ATTENDINGS_TABLE, clinic
// rows for CLINICS_TABLE.
// ---------------------------------------------------------------------------

function makeReader(
  attendingRows: Array<{ id: string; fields: Record<string, unknown> }>,
  clinicRows: Array<{ id: string; fields: Record<string, unknown> }> = []
): AirtableReader {
  return {
    async listAll(_base: string, table: string) {
      if (table === CLINICS_TABLE) return clinicRows;
      return attendingRows;
    },
  };
}

// ---------------------------------------------------------------------------
// parseClinicDate unit tests
// ---------------------------------------------------------------------------

describe("parseClinicDate", () => {
  const term = { clinicDates: [CLINIC_DATE_1, CLINIC_DATE_2] };

  it("parses an ISO date string matching a clinic date", () => {
    const result = parseClinicDate("2026-06-06", term);
    expect(result).not.toBeNull();
    expect(result!.toISOString()).toBe(CLINIC_DATE_1.toISOString());
  });

  it("parses an ISO datetime string (YYYY-MM-DDT...) matching a clinic date", () => {
    const result = parseClinicDate("2026-06-06T08:30:00", term);
    expect(result).not.toBeNull();
    expect(result!.toISOString()).toBe(CLINIC_DATE_1.toISOString());
  });

  it("returns null for an ISO date not in clinic dates", () => {
    const result = parseClinicDate("2026-07-04", term);
    expect(result).toBeNull();
  });

  it("parses 'June 6th' display format (ordinal suffix stripped)", () => {
    const result = parseClinicDate("June 6th", term);
    expect(result).not.toBeNull();
    expect(result!.toISOString()).toBe(CLINIC_DATE_1.toISOString());
  });

  it("parses 'june 6' case-insensitively", () => {
    const result = parseClinicDate("june 6", term);
    expect(result).not.toBeNull();
    expect(result!.toISOString()).toBe(CLINIC_DATE_1.toISOString());
  });

  it("parses 'June 13th' matching second clinic date", () => {
    const result = parseClinicDate("June 13th", term);
    expect(result).not.toBeNull();
    expect(result!.toISOString()).toBe(CLINIC_DATE_2.toISOString());
  });

  it("parses 'August 1st' correctly (does not eat the month name)", () => {
    const aug = new Date("2026-08-01T12:00:00Z");
    const termWithAug = { clinicDates: [aug] };
    const result = parseClinicDate("August 1st", termWithAug);
    expect(result).not.toBeNull();
    expect(result!.toISOString()).toBe(aug.toISOString());
  });

  it("returns null for a display date not in clinic dates", () => {
    const result = parseClinicDate("June 7th", term);
    expect(result).toBeNull();
  });

  it("returns null for garbage input", () => {
    const result = parseClinicDate("not a date at all", term);
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// runRhdImport tests
// ---------------------------------------------------------------------------

describe("runRhdImport", () => {
  beforeEach(resetDb);

  // -------------------------------------------------------------------------
  // Attending: create
  // -------------------------------------------------------------------------

  it("creates a new RhdAttending row from an attending record", async () => {
    await seedTerm();

    const reader = makeReader([
      {
        id: REC_DR_JONES,
        fields: {
          [FLD_SCHED_NAME]: "Jones",
          [FLD_FULL_NAME]: "Dr. Alice Jones",
          [FLD_IUD_IN]: "yes",
          [FLD_IUD_OUT]: "no",
          [FLD_NEXPLANON]: "yes",
          [FLD_GAC]: "no",
          [FLD_EMB]: "unknown",
          [FLD_SEES_MALE]: "yes",
          [FLD_NOTES]: "Available Saturdays",
        },
      },
    ]);

    const report = await runRhdImport(reader, { ...BASE_OPTS, dryRun: false });
    expect(report.attendings.created).toBe(1);
    expect(report.attendings.updated).toBe(0);
    expect(report.attendings.unchanged).toBe(0);

    const attending = await prisma.rhdAttending.findUnique({ where: { scheduleName: "Jones" } });
    expect(attending).not.toBeNull();
    expect(attending!.fullName).toBe("Dr. Alice Jones");
    expect(attending!.iudIn).toBe("yes");
    expect(attending!.iudOut).toBe("no");
    expect(attending!.nexplanon).toBe("yes");
    expect(attending!.gac).toBe("no");
    expect(attending!.emb).toBe("unknown");
    expect(attending!.seesMale).toBe("yes");
    expect(attending!.notes).toBe("Available Saturdays");
  });

  it("uses scheduleName as fullName when fullName is blank", async () => {
    await seedTerm();

    const reader = makeReader([
      {
        id: REC_DR_JONES,
        fields: {
          [FLD_SCHED_NAME]: "Jones",
          [FLD_FULL_NAME]: "",
        },
      },
    ]);

    await runRhdImport(reader, { ...BASE_OPTS, dryRun: false });

    const attending = await prisma.rhdAttending.findUnique({ where: { scheduleName: "Jones" } });
    expect(attending!.fullName).toBe("Jones");
  });

  it("skips rows with blank Schedule Name silently", async () => {
    await seedTerm();

    const reader = makeReader([
      { id: "recBlank", fields: { [FLD_SCHED_NAME]: "", [FLD_FULL_NAME]: "Dr. Nobody" } },
      { id: "recNoName", fields: { [FLD_FULL_NAME]: "Dr. Nobody2" } },
    ]);

    const report = await runRhdImport(reader, { ...BASE_OPTS, dryRun: false });
    expect(report.attendings.created).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Attending: select field normalization
  // -------------------------------------------------------------------------

  it("normalizes single-select as plain string 'yes' -> 'yes'", async () => {
    await seedTerm();

    const reader = makeReader([
      { id: REC_DR_JONES, fields: { [FLD_SCHED_NAME]: "Jones", [FLD_IUD_IN]: "yes" } },
    ]);

    await runRhdImport(reader, { ...BASE_OPTS, dryRun: false });
    const a = await prisma.rhdAttending.findUnique({ where: { scheduleName: "Jones" } });
    expect(a!.iudIn).toBe("yes");
  });

  it("normalizes single-select as object {name:'yes'} -> 'yes'", async () => {
    await seedTerm();

    const reader = makeReader([
      { id: REC_DR_JONES, fields: { [FLD_SCHED_NAME]: "Jones", [FLD_IUD_IN]: { name: "yes" } } },
    ]);

    await runRhdImport(reader, { ...BASE_OPTS, dryRun: false });
    const a = await prisma.rhdAttending.findUnique({ where: { scheduleName: "Jones" } });
    expect(a!.iudIn).toBe("yes");
  });

  it("normalizes single-select as object {name:'No'} -> 'no' (lowercased)", async () => {
    await seedTerm();

    const reader = makeReader([
      { id: REC_DR_JONES, fields: { [FLD_SCHED_NAME]: "Jones", [FLD_IUD_IN]: { name: "No" } } },
    ]);

    await runRhdImport(reader, { ...BASE_OPTS, dryRun: false });
    const a = await prisma.rhdAttending.findUnique({ where: { scheduleName: "Jones" } });
    expect(a!.iudIn).toBe("no");
  });

  it("normalizes junk select value to 'unknown'", async () => {
    await seedTerm();

    const reader = makeReader([
      { id: REC_DR_JONES, fields: { [FLD_SCHED_NAME]: "Jones", [FLD_IUD_IN]: "maybe" } },
    ]);

    await runRhdImport(reader, { ...BASE_OPTS, dryRun: false });
    const a = await prisma.rhdAttending.findUnique({ where: { scheduleName: "Jones" } });
    expect(a!.iudIn).toBe("unknown");
  });

  it("normalizes absent select field to 'unknown'", async () => {
    await seedTerm();

    const reader = makeReader([
      { id: REC_DR_JONES, fields: { [FLD_SCHED_NAME]: "Jones" } },
    ]);

    await runRhdImport(reader, { ...BASE_OPTS, dryRun: false });
    const a = await prisma.rhdAttending.findUnique({ where: { scheduleName: "Jones" } });
    expect(a!.iudIn).toBe("unknown");
    expect(a!.nexplanon).toBe("unknown");
    expect(a!.seesMale).toBe("unknown");
  });

  // -------------------------------------------------------------------------
  // Attending: update and unchanged
  // -------------------------------------------------------------------------

  it("updates an existing attending when a field changes", async () => {
    await seedTerm();

    const reader1 = makeReader([
      { id: REC_DR_JONES, fields: { [FLD_SCHED_NAME]: "Jones", [FLD_IUD_IN]: "yes" } },
    ]);
    await runRhdImport(reader1, { ...BASE_OPTS, dryRun: false });

    const reader2 = makeReader([
      { id: REC_DR_JONES, fields: { [FLD_SCHED_NAME]: "Jones", [FLD_IUD_IN]: "no" } },
    ]);
    const report = await runRhdImport(reader2, { ...BASE_OPTS, dryRun: false });
    expect(report.attendings.updated).toBe(1);
    expect(report.attendings.created).toBe(0);

    const a = await prisma.rhdAttending.findUnique({ where: { scheduleName: "Jones" } });
    expect(a!.iudIn).toBe("no");
  });

  it("marks attending unchanged on second identical run", async () => {
    await seedTerm();

    const reader = makeReader([
      { id: REC_DR_JONES, fields: { [FLD_SCHED_NAME]: "Jones", [FLD_IUD_IN]: "yes" } },
    ]);

    await runRhdImport(reader, { ...BASE_OPTS, dryRun: false });
    const report = await runRhdImport(reader, { ...BASE_OPTS, dryRun: false });
    expect(report.attendings.unchanged).toBe(1);
    expect(report.attendings.updated).toBe(0);
    expect(report.attendings.created).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Clinic: ISO date
  // -------------------------------------------------------------------------

  it("creates a clinic row from an ISO date matching a term clinic date", async () => {
    await seedTerm();

    const reader = makeReader(
      [{ id: REC_DR_JONES, fields: { [FLD_SCHED_NAME]: "Jones" } }],
      [
        {
          id: "clinicRow1",
          fields: {
            [FLD_DATE]: "2026-06-06",
            [FLD_ATTENDING_LINK]: [REC_DR_JONES],
            [FLD_DIRECTOR]: "Dr. Smith",
            [FLD_PROCEDURES]: 3,
          },
        },
      ]
    );

    const report = await runRhdImport(reader, { ...BASE_OPTS, dryRun: false });
    expect(report.clinics.created).toBe(1);
    expect(report.skippedClinicDates).toHaveLength(0);

    const clinic = await prisma.rhdClinic.findFirst();
    expect(clinic).not.toBeNull();
    expect(clinic!.directorName).toBe("Dr. Smith");
    expect(clinic!.proceduresBooked).toBe(3);
  });

  it("creates a clinic row from a display date ('June 6th')", async () => {
    await seedTerm();

    const reader = makeReader(
      [{ id: REC_DR_JONES, fields: { [FLD_SCHED_NAME]: "Jones" } }],
      [
        {
          id: "clinicRow1",
          fields: {
            [FLD_DATE]: "June 6th",
            [FLD_ATTENDING_LINK]: [REC_DR_JONES],
          },
        },
      ]
    );

    const report = await runRhdImport(reader, { ...BASE_OPTS, dryRun: false });
    expect(report.clinics.created).toBe(1);
    expect(report.skippedClinicDates).toHaveLength(0);
  });

  it("adds unparseable date to skippedClinicDates (deduped)", async () => {
    await seedTerm();

    const reader = makeReader([], [
      { id: "clinicBad1", fields: { [FLD_DATE]: "garbage date" } },
      { id: "clinicBad2", fields: { [FLD_DATE]: "garbage date" } },
    ]);

    const report = await runRhdImport(reader, { ...BASE_OPTS, dryRun: false });
    expect(report.skippedClinicDates).toHaveLength(1);
    expect(report.skippedClinicDates[0]).toBe("garbage date");
    expect(report.clinics.created).toBe(0);
  });

  it("adds non-clinic ISO date to skippedClinicDates", async () => {
    await seedTerm();

    const reader = makeReader([], [
      { id: "clinicOff", fields: { [FLD_DATE]: "2026-07-04" } },
    ]);

    const report = await runRhdImport(reader, { ...BASE_OPTS, dryRun: false });
    expect(report.skippedClinicDates).toContain("2026-07-04");
  });

  // -------------------------------------------------------------------------
  // Clinic: attending link resolution
  // -------------------------------------------------------------------------

  it("resolves attending link to set attendingId on the clinic row", async () => {
    await seedTerm();

    const reader = makeReader(
      [{ id: REC_DR_JONES, fields: { [FLD_SCHED_NAME]: "Jones" } }],
      [
        {
          id: "clinicRow1",
          fields: {
            [FLD_DATE]: "2026-06-06",
            [FLD_ATTENDING_LINK]: [REC_DR_JONES],
          },
        },
      ]
    );

    await runRhdImport(reader, { ...BASE_OPTS, dryRun: false });

    const attending = await prisma.rhdAttending.findUnique({ where: { scheduleName: "Jones" } });
    const clinic = await prisma.rhdClinic.findFirst();
    expect(clinic!.attendingId).toBe(attending!.id);
  });

  it("adds unresolved attending record id to unresolvedAttendings; clinic imported with attendingId null", async () => {
    await seedTerm();

    const reader = makeReader(
      [], // No attendings
      [
        {
          id: "clinicRow1",
          fields: {
            [FLD_DATE]: "2026-06-06",
            [FLD_ATTENDING_LINK]: [REC_DR_JONES], // Not in attendings table
          },
        },
      ]
    );

    const report = await runRhdImport(reader, { ...BASE_OPTS, dryRun: false });
    expect(report.unresolvedAttendings).toContain(REC_DR_JONES);
    expect(report.clinics.created).toBe(1);

    const clinic = await prisma.rhdClinic.findFirst();
    expect(clinic!.attendingId).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Clinic: upsert idempotency
  // -------------------------------------------------------------------------

  it("second run on identical clinic data produces unchanged=1, created=0", async () => {
    await seedTerm();

    const reader = makeReader(
      [{ id: REC_DR_JONES, fields: { [FLD_SCHED_NAME]: "Jones" } }],
      [
        {
          id: "clinicRow1",
          fields: {
            [FLD_DATE]: "2026-06-06",
            [FLD_ATTENDING_LINK]: [REC_DR_JONES],
            [FLD_PROCEDURES]: 2,
          },
        },
      ]
    );

    await runRhdImport(reader, { ...BASE_OPTS, dryRun: false });
    const second = await runRhdImport(reader, { ...BASE_OPTS, dryRun: false });

    expect(second.clinics.created).toBe(0);
    expect(second.clinics.updated).toBe(0);
    expect(second.clinics.unchanged).toBe(1);
  });

  it("updates clinic row when proceduresBooked changes", async () => {
    await seedTerm();

    const reader1 = makeReader(
      [{ id: REC_DR_JONES, fields: { [FLD_SCHED_NAME]: "Jones" } }],
      [
        {
          id: "clinicRow1",
          fields: {
            [FLD_DATE]: "2026-06-06",
            [FLD_ATTENDING_LINK]: [REC_DR_JONES],
            [FLD_PROCEDURES]: 2,
          },
        },
      ]
    );

    await runRhdImport(reader1, { ...BASE_OPTS, dryRun: false });

    const reader2 = makeReader(
      [{ id: REC_DR_JONES, fields: { [FLD_SCHED_NAME]: "Jones" } }],
      [
        {
          id: "clinicRow1",
          fields: {
            [FLD_DATE]: "2026-06-06",
            [FLD_ATTENDING_LINK]: [REC_DR_JONES],
            [FLD_PROCEDURES]: 5,
          },
        },
      ]
    );

    const report = await runRhdImport(reader2, { ...BASE_OPTS, dryRun: false });
    expect(report.clinics.updated).toBe(1);
    expect(report.clinics.created).toBe(0);

    const clinic = await prisma.rhdClinic.findFirst();
    expect(clinic!.proceduresBooked).toBe(5);
  });

  // -------------------------------------------------------------------------
  // Dry run: no writes
  // -------------------------------------------------------------------------

  it("dry run counts creations without writing to the database", async () => {
    await seedTerm();

    const reader = makeReader(
      [{ id: REC_DR_JONES, fields: { [FLD_SCHED_NAME]: "Jones" } }],
      [
        {
          id: "clinicRow1",
          fields: {
            [FLD_DATE]: "2026-06-06",
            [FLD_ATTENDING_LINK]: [REC_DR_JONES],
            [FLD_PROCEDURES]: 2,
          },
        },
      ]
    );

    const report = await runRhdImport(reader, { ...BASE_OPTS, dryRun: true });
    expect(report.attendings.created).toBe(1);
    expect(report.clinics.created).toBe(1);

    // Nothing written
    expect(await prisma.rhdAttending.count()).toBe(0);
    expect(await prisma.rhdClinic.count()).toBe(0);
    expect(await prisma.auditLog.count()).toBe(0);
  });

  it("dry run clinic resolution uses in-memory sentinel so clinics are attributed correctly", async () => {
    await seedTerm();

    const reader = makeReader(
      [{ id: REC_DR_JONES, fields: { [FLD_SCHED_NAME]: "Jones" } }],
      [
        {
          id: "clinicRow1",
          fields: {
            [FLD_DATE]: "2026-06-06",
            [FLD_ATTENDING_LINK]: [REC_DR_JONES],
          },
        },
      ]
    );

    // In dry-run mode the clinic should resolve the attending (no unresolved)
    const report = await runRhdImport(reader, { ...BASE_OPTS, dryRun: true });
    expect(report.unresolvedAttendings).toHaveLength(0);
    expect(report.clinics.created).toBe(1);
  });

  // -------------------------------------------------------------------------
  // Missing term throws
  // -------------------------------------------------------------------------

  it("throws a clear error when the term is missing", async () => {
    const reader = makeReader([], []);

    await expect(
      runRhdImport(reader, { ...BASE_OPTS, termCode: "MISSING99", dryRun: false })
    ).rejects.toThrow(/MISSING99/);
  });

  // -------------------------------------------------------------------------
  // Apply mode writes audit entry
  // -------------------------------------------------------------------------

  it("apply mode writes exactly one schedule.rhd_import audit entry", async () => {
    await seedTerm();

    const reader = makeReader(
      [{ id: REC_DR_JONES, fields: { [FLD_SCHED_NAME]: "Jones" } }],
      []
    );

    await runRhdImport(reader, { ...BASE_OPTS, dryRun: false });

    const audit = await prisma.auditLog.findFirst({ where: { action: "schedule.rhd_import" } });
    expect(audit).not.toBeNull();
    expect(audit!.actorPersonId).toBeNull();
    const after = audit!.after as Record<string, unknown>;
    expect(typeof after).toBe("object");
  });

  // -------------------------------------------------------------------------
  // Null handling
  // -------------------------------------------------------------------------

  it("sets directorName and proceduresBooked to null when absent", async () => {
    await seedTerm();

    const reader = makeReader(
      [{ id: REC_DR_JONES, fields: { [FLD_SCHED_NAME]: "Jones" } }],
      [
        {
          id: "clinicRow1",
          fields: {
            [FLD_DATE]: "2026-06-06",
            // No director, no procedures
          },
        },
      ]
    );

    await runRhdImport(reader, { ...BASE_OPTS, dryRun: false });

    const clinic = await prisma.rhdClinic.findFirst();
    expect(clinic!.directorName).toBeNull();
    expect(clinic!.proceduresBooked).toBeNull();
  });
});
