import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";

async function seed() {
  const term = await prisma.term.create({
    data: {
      code: "TS26",
      name: "Test 2026",
      startDate: new Date("2026-01-01T00:00:00Z"),
      endDate: new Date("2026-06-01T00:00:00Z"),
      status: "ACTIVE",
      clinicDates: [new Date("2026-03-07T12:00:00Z")],
    },
  });
  const person = await prisma.person.create({ data: { name: "Ada Lovelace" } });
  return { term, person };
}

describe("ClinicAttendance schema", () => {
  beforeEach(resetDb);

  it("stores one row per person per clinic day", async () => {
    const { term, person } = await seed();
    const row = await prisma.clinicAttendance.create({
      data: {
        termId: term.id,
        clinicDate: new Date("2026-03-07T12:00:00Z"),
        personId: person.id,
        method: "SELF_GEO",
        distanceMeters: 42,
        accuracyMeters: 15,
      },
    });
    expect(row.method).toBe("SELF_GEO");
    expect(row.recordedById).toBeNull();
  });

  it("rejects a second row for the same person and clinic day", async () => {
    const { term, person } = await seed();
    const data = {
      termId: term.id,
      clinicDate: new Date("2026-03-07T12:00:00Z"),
      personId: person.id,
      method: "SELF_GEO" as const,
    };
    await prisma.clinicAttendance.create({ data });
    await expect(prisma.clinicAttendance.create({ data })).rejects.toThrow();
  });

  it("keeps the row when the recorder is deleted, and drops it when the subject is", async () => {
    const { term, person } = await seed();
    const recorder = await prisma.person.create({ data: { name: "Grace Hopper" } });
    const row = await prisma.clinicAttendance.create({
      data: {
        termId: term.id,
        clinicDate: new Date("2026-03-07T12:00:00Z"),
        personId: person.id,
        method: "STAFF",
        recordedById: recorder.id,
      },
    });

    await prisma.person.delete({ where: { id: recorder.id } });
    const afterRecorderGone = await prisma.clinicAttendance.findUnique({ where: { id: row.id } });
    expect(afterRecorderGone?.recordedById).toBeNull();

    await prisma.person.delete({ where: { id: person.id } });
    expect(await prisma.clinicAttendance.findUnique({ where: { id: row.id } })).toBeNull();
  });
});
