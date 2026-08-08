import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Prisma } from "@prisma/client";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { setSetting } from "@/platform/settings/service";
import * as settings from "@/platform/settings/service";
import { checkInSelf, getCheckInState, writeAttendance, markPresent, undoAttendance, attendanceForDate } from "./attendance";

const CLINIC_DATE = new Date("2026-03-07T12:00:00Z");
// A Saturday morning instant that falls on CLINIC_DATE in Eastern Time.
const SATURDAY_MORNING = new Date("2026-03-07T13:30:00Z");
const CLINIC = { latitude: 41.3025, longitude: -72.937 };
const FAR_AWAY = { latitude: 42.3601, longitude: -71.0589 }; // Boston

// setSetting takes THREE arguments: (key, rawValue, actorPersonId).
async function configureFence() {
  await setSetting("clinic.checkInLatitude", CLINIC.latitude, null);
  await setSetting("clinic.checkInLongitude", CLINIC.longitude, null);
  await setSetting("clinic.checkInRadiusMeters", 250, null);
  await setSetting("clinic.checkInMaxAccuracyMeters", 200, null);
}

async function seed(opts: { remote?: boolean; assigned?: boolean } = {}) {
  const { remote = false, assigned = true } = opts;
  const term = await prisma.term.create({
    data: {
      code: "TS26",
      name: "Test 2026",
      startDate: new Date("2026-01-01T00:00:00Z"),
      endDate: new Date("2026-06-01T00:00:00Z"),
      status: "ACTIVE",
      clinicDates: [CLINIC_DATE],
    },
  });
  const dept = await prisma.department.create({ data: { code: "SCTP", name: "Screening" } });
  const person = await prisma.person.create({ data: { name: "Ada Lovelace" } });
  await prisma.termMembership.create({
    // kind is a required field with no default; the brief's fixture omitted
    // it. Not part of the behavior under test, so VOLUNTEER (matching the
    // ShiftAssignment role below) is the neutral choice.
    data: { termId: term.id, departmentId: dept.id, personId: person.id, status: "ACTIVE", kind: "VOLUNTEER" },
  });
  if (assigned) {
    await prisma.shiftAssignment.create({
      data: {
        termId: term.id,
        departmentId: dept.id,
        personId: person.id,
        clinicDate: CLINIC_DATE,
        role: "VOLUNTEER",
        remote,
      },
    });
  }
  return { term, dept, person };
}

describe("checkInSelf", () => {
  beforeEach(async () => {
    await resetDb();
    await configureFence();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("writes a SELF_GEO row for an assigned person inside the fence", async () => {
    const { person, term } = await seed();
    const res = await checkInSelf(
      person.id,
      { coords: CLINIC, accuracyMeters: 20 },
      SATURDAY_MORNING,
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.method).toBe("SELF_GEO");

    const row = await prisma.clinicAttendance.findFirst({ where: { personId: person.id } });
    expect(row?.method).toBe("SELF_GEO");
    expect(row?.termId).toBe(term.id);
    expect(row?.distanceMeters).toBe(0);
    expect(row?.accuracyMeters).toBe(20);
    expect(row?.recordedById).toBeNull();
  });

  it("never persists raw coordinates", async () => {
    const { person } = await seed();
    await checkInSelf(person.id, { coords: CLINIC, accuracyMeters: 20 }, SATURDAY_MORNING);
    const row = await prisma.clinicAttendance.findFirstOrThrow({ where: { personId: person.id } });
    expect(Object.keys(row)).not.toContain("latitude");
    expect(Object.keys(row)).not.toContain("longitude");
    expect(JSON.stringify(row)).not.toContain("-72.937");
  });

  it("rejects a fix outside the radius and writes nothing", async () => {
    const { person } = await seed();
    const res = await checkInSelf(person.id, { coords: FAR_AWAY, accuracyMeters: 20 }, SATURDAY_MORNING);
    expect(res).toEqual({ ok: false, reason: "OUT_OF_RANGE" });
    expect(await prisma.clinicAttendance.count()).toBe(0);
  });

  it("rejects an imprecise fix and writes nothing", async () => {
    const { person } = await seed();
    const res = await checkInSelf(person.id, { coords: CLINIC, accuracyMeters: 900 }, SATURDAY_MORNING);
    expect(res).toEqual({ ok: false, reason: "TOO_IMPRECISE" });
    expect(await prisma.clinicAttendance.count()).toBe(0);
  });

  it("treats a null position as POSITION_UNAVAILABLE", async () => {
    const { person } = await seed();
    const res = await checkInSelf(person.id, null, SATURDAY_MORNING);
    expect(res).toEqual({ ok: false, reason: "POSITION_UNAVAILABLE" });
  });

  it("waives the fence when every assignment that day is remote", async () => {
    const { person } = await seed({ remote: true });
    const res = await checkInSelf(person.id, null, SATURDAY_MORNING);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.method).toBe("SELF_REMOTE");

    const row = await prisma.clinicAttendance.findFirstOrThrow({ where: { personId: person.id } });
    expect(row.distanceMeters).toBeNull();
    expect(row.accuracyMeters).toBeNull();
  });

  it("does NOT waive the fence when only some assignments are remote", async () => {
    const { person, term } = await seed({ remote: true });
    const other = await prisma.department.create({ data: { code: "JCTP", name: "Joint Clinic" } });
    await prisma.termMembership.create({
      data: { termId: term.id, departmentId: other.id, personId: person.id, status: "ACTIVE", kind: "VOLUNTEER" },
    });
    await prisma.shiftAssignment.create({
      data: {
        termId: term.id,
        departmentId: other.id,
        personId: person.id,
        clinicDate: CLINIC_DATE,
        role: "VOLUNTEER",
        remote: false,
      },
    });

    const res = await checkInSelf(person.id, null, SATURDAY_MORNING);
    expect(res).toEqual({ ok: false, reason: "POSITION_UNAVAILABLE" });
  });

  it("blocks an unassigned person rather than treating them as vacuously all-remote", async () => {
    const { person } = await seed({ assigned: false });
    const res = await checkInSelf(person.id, null, SATURDAY_MORNING);
    expect(res).toEqual({ ok: false, reason: "NOT_ASSIGNED" });
    expect(await prisma.clinicAttendance.count()).toBe(0);
  });

  it("rejects a non-clinic day", async () => {
    const { person } = await seed();
    const wednesday = new Date("2026-03-04T13:30:00Z");
    const res = await checkInSelf(person.id, { coords: CLINIC, accuracyMeters: 20 }, wednesday);
    expect(res).toEqual({ ok: false, reason: "NOT_A_CLINIC_DAY" });
  });

  it("is idempotent: a second tap returns the original arrival time", async () => {
    const { person } = await seed();
    const first = await checkInSelf(person.id, { coords: CLINIC, accuracyMeters: 20 }, SATURDAY_MORNING);
    const second = await checkInSelf(person.id, { coords: CLINIC, accuracyMeters: 20 }, SATURDAY_MORNING);

    expect(first.ok && second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(second.alreadyCheckedIn).toBe(true);
      expect(second.checkedInAt.getTime()).toBe(first.checkedInAt.getTime());
    }
    expect(await prisma.clinicAttendance.count()).toBe(1);
  });

  it("fails closed when a fence setting resolves to a non-finite number", async () => {
    // The brief's original approach corrupted the stored Setting row directly
    // (value: "null") to provoke this guard. That does not actually reach
    // resolveFence(): the settings service's resolveStored() treats ANY value
    // that fails its zod schema as "invalid" and silently substitutes the env
    // default, warning but never propagating the bad value to the caller (see
    // platform/settings/service.ts). Verified directly: upserting that same
    // corrupt row and reading it back through getSetting still yields the
    // valid default 41.3025, so the resulting check-in actually SUCCEEDS
    // instead of failing closed -- the opposite of what the brief's test
    // asserts. Stubbing getSetting itself is the only way to exercise
    // resolveFence's fail-closed branch as things stand today.
    const { person } = await seed();
    const realGetSetting = settings.getSetting;
    vi.spyOn(settings, "getSetting").mockImplementation(async (key: string) => {
      if (key === "clinic.checkInLatitude") return NaN as never;
      return realGetSetting(key);
    });

    const res = await checkInSelf(person.id, { coords: CLINIC, accuracyMeters: 20 }, SATURDAY_MORNING);
    expect(res).toEqual({ ok: false, reason: "FENCE_UNCONFIGURED" });
    // Failing OPEN would be worse than having no fence at all, because a fence
    // that silently passes everyone would still be trusted.
    expect(await prisma.clinicAttendance.count()).toBe(0);
  });

  it("rejects an offboarded person", async () => {
    const { person } = await seed();
    await prisma.person.update({ where: { id: person.id }, data: { status: "OFFBOARDED" } });
    const res = await checkInSelf(person.id, { coords: CLINIC, accuracyMeters: 20 }, SATURDAY_MORNING);
    expect(res).toEqual({ ok: false, reason: "NOT_ELIGIBLE" });
    expect(await prisma.clinicAttendance.count()).toBe(0);
  });

  it("rejects when there is no active term", async () => {
    const { person, term } = await seed();
    await prisma.term.update({ where: { id: term.id }, data: { status: "ARCHIVED" } });
    const res = await checkInSelf(person.id, { coords: CLINIC, accuracyMeters: 20 }, SATURDAY_MORNING);
    expect(res).toEqual({ ok: false, reason: "NOT_A_CLINIC_DAY" });
  });
});

describe("getCheckInState", () => {
  beforeEach(async () => {
    await resetDb();
    await configureFence();
  });

  it("reports an existing check-in", async () => {
    const { person } = await seed();
    await checkInSelf(person.id, { coords: CLINIC, accuracyMeters: 20 }, SATURDAY_MORNING);
    const state = await getCheckInState(person.id, SATURDAY_MORNING);
    expect(state.existing?.method).toBe("SELF_GEO");
    expect(state.assignmentCount).toBe(1);
    expect(state.allRemote).toBe(false);
  });

  it("reports no clinic date on a non-clinic day", async () => {
    const { person } = await seed();
    const state = await getCheckInState(person.id, new Date("2026-03-04T13:30:00Z"));
    expect(state.clinicDate).toBeNull();
  });
});

describe("writeAttendance", () => {
  beforeEach(resetDb);

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("on a genuine unique-constraint collision, returns the winning row instead of the write it attempted", async () => {
    const { term, person } = await seed();

    // Simulate a concurrent writer landing between writeAttendance's own
    // "does a row already exist" read and its create(): insert the winning
    // row for real from inside the mocked read, so the create() call below
    // hits an actual Postgres P2002, not a fabricated one.
    vi.spyOn(prisma.clinicAttendance, "findUnique").mockImplementationOnce((async () => {
      await prisma.clinicAttendance.create({
        data: {
          termId: term.id,
          clinicDate: CLINIC_DATE,
          personId: person.id,
          method: "STAFF",
          recordedById: null,
        },
      });
      return null; // what this call's own read saw a moment before the race landed
    }) as never);

    const res = await writeAttendance({
      termId: term.id,
      clinicDate: CLINIC_DATE,
      personId: person.id,
      method: "SELF_GEO",
      distanceMeters: 10,
      accuracyMeters: 15,
      recordedById: null,
      note: null,
    });

    expect(res).toEqual({
      ok: true,
      alreadyCheckedIn: true,
      checkedInAt: expect.any(Date),
      method: "STAFF", // the actual winner, not the SELF_GEO this call tried to write
    });
    expect(await prisma.clinicAttendance.count()).toBe(1);
  });

  it("propagates a non-unique-constraint failure instead of reporting success or a misleading message", async () => {
    const { term, person } = await seed();
    const fkError = new Prisma.PrismaClientKnownRequestError("Foreign key constraint failed", {
      code: "P2003",
      clientVersion: "test",
    });
    vi.spyOn(prisma.clinicAttendance, "create").mockRejectedValueOnce(fkError);

    await expect(
      writeAttendance({
        termId: term.id,
        clinicDate: CLINIC_DATE,
        personId: person.id,
        method: "SELF_GEO",
        distanceMeters: 10,
        accuracyMeters: 15,
        recordedById: null,
        note: null,
      }),
    ).rejects.toBe(fkError);
    expect(await prisma.clinicAttendance.count()).toBe(0);
  });
});

describe("markPresent", () => {
  beforeEach(async () => {
    await resetDb();
    await configureFence();
  });

  it("records a STAFF row with the recorder attributed", async () => {
    const { person } = await seed();
    const director = await prisma.person.create({ data: { name: "Grace Hopper" } });

    const res = await markPresent(director.id, person.id, { note: "Phone had no signal" }, SATURDAY_MORNING);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.method).toBe("STAFF");

    const row = await prisma.clinicAttendance.findFirstOrThrow({ where: { personId: person.id } });
    expect(row.recordedById).toBe(director.id);
    expect(row.note).toBe("Phone had no signal");
    expect(row.distanceMeters).toBeNull();
  });

  it("records an UNASSIGNED person, so who-is-here stays honest", async () => {
    const { term } = await seed();
    const director = await prisma.person.create({ data: { name: "Grace Hopper" } });
    const walkOn = await prisma.person.create({ data: { name: "Katherine Johnson" } });

    const res = await markPresent(director.id, walkOn.id, {}, SATURDAY_MORNING);
    expect(res.ok).toBe(true);

    const row = await prisma.clinicAttendance.findFirstOrThrow({ where: { personId: walkOn.id } });
    expect(row.termId).toBe(term.id);
    // No assignment exists, so this person is present but not in the no-show denominator.
    const assignments = await prisma.shiftAssignment.count({ where: { personId: walkOn.id } });
    expect(assignments).toBe(0);
  });

  it("rejects an offboarded subject", async () => {
    const { person } = await seed();
    const director = await prisma.person.create({ data: { name: "Grace Hopper" } });
    await prisma.person.update({ where: { id: person.id }, data: { status: "OFFBOARDED" } });

    const res = await markPresent(director.id, person.id, {}, SATURDAY_MORNING);
    expect(res).toEqual({ ok: false, reason: "NOT_ELIGIBLE" });
  });

  it("rejects a non-clinic day", async () => {
    const { person } = await seed();
    const director = await prisma.person.create({ data: { name: "Grace Hopper" } });
    const res = await markPresent(director.id, person.id, {}, new Date("2026-03-04T13:30:00Z"));
    expect(res).toEqual({ ok: false, reason: "NOT_A_CLINIC_DAY" });
  });

  it("is idempotent against an existing self check-in", async () => {
    const { person } = await seed();
    const director = await prisma.person.create({ data: { name: "Grace Hopper" } });
    await checkInSelf(person.id, { coords: CLINIC, accuracyMeters: 20 }, SATURDAY_MORNING);

    const res = await markPresent(director.id, person.id, {}, SATURDAY_MORNING);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.alreadyCheckedIn).toBe(true);
      // The original SELF_GEO record is NOT overwritten by a STAFF one.
      expect(res.method).toBe("SELF_GEO");
    }
    expect(await prisma.clinicAttendance.count()).toBe(1);
  });
});

describe("undoAttendance", () => {
  beforeEach(async () => {
    await resetDb();
    await configureFence();
  });

  it("removes the row so a misclick can be corrected", async () => {
    const { person } = await seed();
    await checkInSelf(person.id, { coords: CLINIC, accuracyMeters: 20 }, SATURDAY_MORNING);
    expect(await prisma.clinicAttendance.count()).toBe(1);

    await undoAttendance(person.id, SATURDAY_MORNING);
    expect(await prisma.clinicAttendance.count()).toBe(0);
  });

  it("is a no-op when there is nothing to undo", async () => {
    const { person } = await seed();
    await expect(undoAttendance(person.id, SATURDAY_MORNING)).resolves.toBeUndefined();
  });
});

describe("attendanceForDate", () => {
  beforeEach(async () => {
    await resetDb();
    await configureFence();
  });

  it("returns a map keyed by personId", async () => {
    const { person, term } = await seed();
    await checkInSelf(person.id, { coords: CLINIC, accuracyMeters: 20 }, SATURDAY_MORNING);

    const map = await attendanceForDate(term.id, CLINIC_DATE);
    expect(map.get(person.id)?.method).toBe("SELF_GEO");
    expect(map.size).toBe(1);
  });

  it("is empty for a date with no attendance", async () => {
    const { term } = await seed();
    const map = await attendanceForDate(term.id, CLINIC_DATE);
    expect(map.size).toBe(0);
  });
});
