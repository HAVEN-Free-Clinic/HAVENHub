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

/**
 * The service line this importer writes into.
 *
 * Attendings and clinic rows are department-scoped since primary care was added,
 * and this importer reads the legacy reproductive health sheet, so everything it
 * creates belongs to SRHD. runRhdImport throws a readable error when SRHD is
 * absent rather than writing unattributed rows, which is why every test here
 * needs it seeded.
 */
const RHD_CAPABILITY_KEYS = ["iudIn", "iudOut", "nexplanon", "gac", "emb", "seesMale"];

/**
 * The reference data this sheet's rows land in.
 *
 * The importer classifies every attending it creates as reproductive health and
 * writes every assignment into the RHD Attending column of the clinic-wide
 * schedule, refusing to run without either -- so both are required here rather
 * than incidental.
 */
async function seedServiceLine() {
  const specialty = await prisma.attendingSpecialty.upsert({
    where: { code: "RHD" },
    update: {},
    create: { code: "RHD", name: "Reproductive Health", order: 1 },
  });
  for (const [order, key] of RHD_CAPABILITY_KEYS.entries()) {
    await prisma.attendingCapability.upsert({
      where: { key },
      update: {},
      create: { key, label: key, order, specialtyId: specialty.id },
    });
  }
  await prisma.clinicSlot.upsert({
    where: { label: "RHD Attending" },
    update: {},
    create: { label: "RHD Attending", startTime: "09:00", endTime: "13:00", order: 0 },
  });
  return specialty;
}

/** Who the import put on a clinic day, in the RHD Attending column. */
async function clinicAttendingId(clinicDayId: string): Promise<string | null> {
  const row = await prisma.clinicDayAttending.findFirst({
    where: { clinicDayId },
    select: { attendingId: true },
  });
  return row?.attendingId ?? null;
}

/** Create a clinic day already staffed by `attendingId`, as a director would. */
async function seedStaffedClinicDay(termId: string, clinicDate: Date, attendingId: string) {
  const slot = await prisma.clinicSlot.findUniqueOrThrow({ where: { label: "RHD Attending" } });
  return prisma.clinicDay.create({
    data: {
      termId,
      clinicDate,
      attendings: { create: [{ slotId: slot.id, attendingId }] },
    },
  });
}

/**
 * An attending's answers as key -> value.
 *
 * Absence IS "unknown" (the importer stores no row for it), so this fills the
 * gaps rather than making every caller special-case a missing key.
 */
async function procedures(scheduleName: string): Promise<Record<string, string>> {
  const a = await prisma.attending.findUniqueOrThrow({
    where: { scheduleName },
    include: { capabilities: { include: { capability: { select: { key: true } } } } },
  });
  const stored = new Map(a.capabilities.map((c) => [c.capability.key, c.value]));
  return Object.fromEntries(RHD_CAPABILITY_KEYS.map((k) => [k, stored.get(k) ?? "unknown"]));
}

async function seedTerm() {
  await seedServiceLine();
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

/** The seeded specialty's id, for tests that create attendings directly. */
async function rhdSpecialtyId() {
  return (await prisma.attendingSpecialty.findUniqueOrThrow({ where: { code: "RHD" } })).id;
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

  it("creates a new Attending row from an attending record", async () => {
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

    const attending = await prisma.attending.findUnique({ where: { scheduleName: "Jones" } });
    expect(attending).not.toBeNull();
    expect(attending!.fullName).toBe("Dr. Alice Jones");
    expect(attending!.notes).toBe("Available Saturdays");
    expect(await procedures("Jones")).toEqual({
      iudIn: "yes",
      iudOut: "no",
      nexplanon: "yes",
      gac: "no",
      emb: "unknown",
      seesMale: "yes",
    });
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

    const attending = await prisma.attending.findUnique({ where: { scheduleName: "Jones" } });
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
    expect((await procedures("Jones")).iudIn).toBe("yes");
  });

  it("normalizes single-select as object {name:'yes'} -> 'yes'", async () => {
    await seedTerm();

    const reader = makeReader([
      { id: REC_DR_JONES, fields: { [FLD_SCHED_NAME]: "Jones", [FLD_IUD_IN]: { name: "yes" } } },
    ]);

    await runRhdImport(reader, { ...BASE_OPTS, dryRun: false });
    expect((await procedures("Jones")).iudIn).toBe("yes");
  });

  it("normalizes single-select as object {name:'No'} -> 'no' (lowercased)", async () => {
    await seedTerm();

    const reader = makeReader([
      { id: REC_DR_JONES, fields: { [FLD_SCHED_NAME]: "Jones", [FLD_IUD_IN]: { name: "No" } } },
    ]);

    await runRhdImport(reader, { ...BASE_OPTS, dryRun: false });
    expect((await procedures("Jones")).iudIn).toBe("no");
  });

  it("normalizes junk select value to 'unknown'", async () => {
    await seedTerm();

    const reader = makeReader([
      { id: REC_DR_JONES, fields: { [FLD_SCHED_NAME]: "Jones", [FLD_IUD_IN]: "maybe" } },
    ]);

    await runRhdImport(reader, { ...BASE_OPTS, dryRun: false });
    expect((await procedures("Jones")).iudIn).toBe("unknown");
  });

  it("normalizes absent select field to 'unknown'", async () => {
    await seedTerm();

    const reader = makeReader([
      { id: REC_DR_JONES, fields: { [FLD_SCHED_NAME]: "Jones" } },
    ]);

    await runRhdImport(reader, { ...BASE_OPTS, dryRun: false });
    // Absent columns store no rows at all, and must still read as "unknown".
    expect(await prisma.attendingCapabilityValue.count()).toBe(0);
    expect((await procedures("Jones")).iudIn).toBe("unknown");
    expect((await procedures("Jones")).nexplanon).toBe("unknown");
    expect((await procedures("Jones")).seesMale).toBe("unknown");
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

    expect((await procedures("Jones")).iudIn).toBe("no");
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

    const clinic = await prisma.clinicDay.findFirst();
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

    const attending = await prisma.attending.findUnique({ where: { scheduleName: "Jones" } });
    const clinic = await prisma.clinicDay.findFirstOrThrow();
    expect(await clinicAttendingId(clinic.id)).toBe(attending!.id);
  });

  it("adds unresolved attending record id to unresolvedAttendings; clinic imported with the slot unstaffed", async () => {
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

    const clinic = await prisma.clinicDay.findFirstOrThrow();
    expect(await clinicAttendingId(clinic.id)).toBeNull();
  });

  it("preserves a director-set attending when the Airtable link is present but unresolved (#120)", async () => {
    const term = await seedTerm();
    // A director already selected Dr Smith for the June 6 clinic in the builder.
    const specialtyId = await rhdSpecialtyId();
    const smith = await prisma.attending.create({ data: { scheduleName: "Smith", fullName: "Dr Smith", specialtyId } });
    await seedStaffedClinicDay(term.id, CLINIC_DATE_1, smith.id);

    // Airtable links June 6 to an attending the import cannot resolve (e.g. it was
    // skipped for a blank Schedule Name), so it never enters the resolve map.
    const reader = makeReader(
      [], // REC_DR_JONES absent -> unresolved
      [{ id: "clinicRow1", fields: { [FLD_DATE]: "2026-06-06", [FLD_ATTENDING_LINK]: [REC_DR_JONES] } }]
    );

    const report = await runRhdImport(reader, { ...BASE_OPTS, dryRun: false });
    expect(report.unresolvedAttendings).toContain(REC_DR_JONES);

    // The director's attending survives: an unresolved link must not clear it.
    const clinic = await prisma.clinicDay.findFirstOrThrow({ where: { termId: term.id } });
    expect(await clinicAttendingId(clinic.id)).toBe(smith.id);
  });

  it("still unstaffs the slot when Airtable genuinely has no attending link", async () => {
    const term = await seedTerm();
    const specialtyId = await rhdSpecialtyId();
    const smith = await prisma.attending.create({ data: { scheduleName: "Smith", fullName: "Dr Smith", specialtyId } });
    await seedStaffedClinicDay(term.id, CLINIC_DATE_1, smith.id);

    // No attending link at all -> a real "Airtable has no attending", which should
    // still clear the field (this is the case the preserve guard must NOT swallow).
    const reader = makeReader([], [{ id: "clinicRow1", fields: { [FLD_DATE]: "2026-06-06" } }]);

    await runRhdImport(reader, { ...BASE_OPTS, dryRun: false });

    const clinic = await prisma.clinicDay.findFirstOrThrow({ where: { termId: term.id } });
    expect(await clinicAttendingId(clinic.id)).toBeNull();
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

    const clinic = await prisma.clinicDay.findFirst();
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
    expect(await prisma.attending.count()).toBe(0);
    expect(await prisma.clinicDay.count()).toBe(0);
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

    const clinic = await prisma.clinicDay.findFirst();
    expect(clinic!.directorName).toBeNull();
    expect(clinic!.proceduresBooked).toBeNull();
  });
});
