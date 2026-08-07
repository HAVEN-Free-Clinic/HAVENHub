import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { setSetting } from "@/platform/settings/service";
import * as settings from "@/platform/settings/service";
import { checkInSelf, getCheckInState } from "./attendance";

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
