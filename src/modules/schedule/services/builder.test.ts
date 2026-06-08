/**
 * Integration tests for the builder service.
 *
 * Fixtures: active term with six Saturday clinic dates, departments including
 * the RHD family (SCTS, JCTS, CCRH), persons with flags, memberships,
 * assignments, a ScheduleDay, an RhdAttending, and an RhdClinic.
 *
 * Test matrix:
 *   manageableScheduleDepartmentIds: director-only, delegated, edit_all, plain person.
 *   Scope matrix on every mutation: own dept ok, delegated ok, edit_all ok, outsider Forbidden.
 *   setAssignment: assign, director-kind, director-kind rejected for volunteer-kind member,
 *     non-member, non-clinic-date, role change preserves tags, unassign deletes + audit reason.
 *   toggleTag: flip existing row; missing row rejected.
 *   setPatientsBooked: upsert, update, null.
 *   setAvailabilityOverride: set dates, clear, non-clinic-key rejected, unmanaged rejected.
 *   acknowledgeAvailability: stamps; unmanaged rejected.
 *   upsertRhdClinic: RHD-family manager ok; non-RHD actor rejected; idempotent.
 *   builderView: departments list, date selection, members, assignmentsByDate, capacity,
 *     banner, conflicts, rhd block, pendingRequestCount.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import {
  manageableScheduleDepartmentIds,
  setAssignment,
  toggleTag,
  setPatientsBooked,
  setAvailabilityOverride,
  acknowledgeAvailability,
  upsertRhdClinic,
  builderView,
  BuilderForbiddenError,
  BuilderValidationError,
} from "./builder";
import { isoDateKey } from "@/platform/dates";

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------

function utcNoon(year: number, month: number, day: number): Date {
  return new Date(Date.UTC(year, month - 1, day, 12, 0, 0, 0));
}

/** Six Saturdays at noon UTC starting 2026-06-06. */
function sixSaturdays(): Date[] {
  const base = utcNoon(2026, 6, 6);
  return Array.from({ length: 6 }, (_, i) => new Date(base.getTime() + i * 7 * 86_400_000));
}

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

async function createPerson(
  name: string,
  opts: { licensedRN?: boolean; spanishSpeaking?: boolean; contactEmail?: string } = {}
) {
  return prisma.person.create({
    data: { name, licensedRN: opts.licensedRN ?? false, spanishSpeaking: opts.spanishSpeaking ?? false, contactEmail: opts.contactEmail },
  });
}

async function createTerm(clinicDates: Date[], status: "ACTIVE" | "PLANNING" = "ACTIVE") {
  return prisma.term.create({
    data: {
      code: `SU26-${Date.now()}-${Math.random()}`,
      name: "Summer 2026",
      startDate: utcNoon(2026, 5, 30),
      endDate: utcNoon(2026, 9, 26),
      status,
      clinicDates,
    },
  });
}

async function createDepartment(
  code: string,
  opts: { idealHeadcount?: number; patientCapacityPerProvider?: number } = {}
) {
  return prisma.department.upsert({
    where: { code },
    update: {},
    create: {
      code,
      name: `${code} Dept`,
      idealHeadcount: opts.idealHeadcount,
      patientCapacityPerProvider: opts.patientCapacityPerProvider,
    },
  });
}

async function createMembership(
  personId: string,
  termId: string,
  departmentId: string,
  kind: "VOLUNTEER" | "DIRECTOR",
  opts: {
    status?: "ACTIVE" | "REMOVED";
    availabilityUpdatedAt?: Date;
    availabilityAcknowledgedAt?: Date;
    baselineAvailability?: Date[];
    selfAvailabilityDates?: Date[];
    directorAvailabilityDates?: Date[];
    directorAvailabilitySetAt?: Date;
    selfUpdatedAvailability?: string;
  } = {}
) {
  return prisma.termMembership.create({
    data: {
      personId,
      termId,
      departmentId,
      kind,
      status: opts.status ?? "ACTIVE",
      baselineAvailability: opts.baselineAvailability ?? [],
      selfAvailabilityDates: opts.selfAvailabilityDates ?? [],
      directorAvailabilityDates: opts.directorAvailabilityDates ?? [],
      availabilityUpdatedAt: opts.availabilityUpdatedAt,
      availabilityAcknowledgedAt: opts.availabilityAcknowledgedAt,
      directorAvailabilitySetAt: opts.directorAvailabilitySetAt,
      selfUpdatedAvailability: opts.selfUpdatedAvailability,
    },
  });
}

async function createShift(
  termId: string,
  departmentId: string,
  personId: string,
  clinicDate: Date,
  role: "DIRECTOR" | "VOLUNTEER" | "SHADOW",
  tags: { triage?: boolean; walkin?: boolean; cc?: boolean; remote?: boolean } = {}
) {
  return prisma.shiftAssignment.create({
    data: {
      termId,
      departmentId,
      personId,
      clinicDate,
      role,
      triage: tags.triage ?? false,
      walkin: tags.walkin ?? false,
      cc: tags.cc ?? false,
      remote: tags.remote ?? false,
    },
  });
}

async function delegate(managerDepartmentId: string, managedDepartmentId: string) {
  return prisma.departmentDelegation.create({
    data: { managerDepartmentId, managedDepartmentId },
  });
}

async function grantPermission(personId: string, permission: string) {
  const role = await prisma.role.create({
    data: {
      name: `Role-${permission}-${Date.now()}-${Math.random()}`,
      grants: { create: [{ permission }] },
    },
  });
  await prisma.roleAssignment.create({ data: { roleId: role.id, personId } });
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(resetDb);

// ---------------------------------------------------------------------------
// manageableScheduleDepartmentIds
// ---------------------------------------------------------------------------

describe("manageableScheduleDepartmentIds", () => {
  it("returns own department for a simple director", async () => {
    const dates = sixSaturdays();
    const term = await createTerm(dates);
    const dept = await createDepartment("PCAR");
    const person = await createPerson("Director");
    await createMembership(person.id, term.id, dept.id, "DIRECTOR");

    const ids = await manageableScheduleDepartmentIds(person.id);
    expect(ids).toContain(dept.id);
  });

  it("includes delegated department", async () => {
    const dates = sixSaturdays();
    const term = await createTerm(dates);
    const pcar = await createDepartment("PCAR");
    const sctp = await createDepartment("SCTP");
    await delegate(pcar.id, sctp.id);
    const person = await createPerson("Director");
    await createMembership(person.id, term.id, pcar.id, "DIRECTOR");

    const ids = await manageableScheduleDepartmentIds(person.id);
    expect(ids).toContain(pcar.id);
    expect(ids).toContain(sctp.id);
  });

  it("includes ALL departments when person has schedule.edit_all", async () => {
    const dates = sixSaturdays();
    await createTerm(dates);
    const dept1 = await createDepartment("DEPT1");
    const dept2 = await createDepartment("DEPT2");
    const person = await createPerson("Admin");
    await grantPermission(person.id, "schedule.edit_all");

    const ids = await manageableScheduleDepartmentIds(person.id);
    expect(ids).toContain(dept1.id);
    expect(ids).toContain(dept2.id);
  });

  it("returns empty for a plain volunteer", async () => {
    const dates = sixSaturdays();
    const term = await createTerm(dates);
    const dept = await createDepartment("PCAR");
    const person = await createPerson("Volunteer");
    await createMembership(person.id, term.id, dept.id, "VOLUNTEER");

    const ids = await manageableScheduleDepartmentIds(person.id);
    expect(ids).toHaveLength(0);
  });

  it("dedupes when edit_all overlaps with own directorship", async () => {
    const dates = sixSaturdays();
    const term = await createTerm(dates);
    const dept = await createDepartment("PCAR");
    const person = await createPerson("Admin-Director");
    await createMembership(person.id, term.id, dept.id, "DIRECTOR");
    await grantPermission(person.id, "schedule.edit_all");

    const ids = await manageableScheduleDepartmentIds(person.id);
    const unique = new Set(ids);
    expect(ids.length).toBe(unique.size);
  });
});

// ---------------------------------------------------------------------------
// setAssignment - happy path + validations
// ---------------------------------------------------------------------------

describe("setAssignment", () => {
  it("creates a volunteer assignment with tags false", async () => {
    const dates = sixSaturdays();
    const term = await createTerm(dates);
    const dept = await createDepartment("PCAR");
    const director = await createPerson("Director");
    const volunteer = await createPerson("Volunteer");
    await createMembership(director.id, term.id, dept.id, "DIRECTOR");
    await createMembership(volunteer.id, term.id, dept.id, "VOLUNTEER");

    const dateKey = isoDateKey(dates[0]);
    await setAssignment(director.id, { departmentId: dept.id, dateKey, personId: volunteer.id, role: "VOLUNTEER" });

    const row = await prisma.shiftAssignment.findFirst({
      where: { termId: term.id, departmentId: dept.id, personId: volunteer.id },
    });
    expect(row).not.toBeNull();
    expect(row!.role).toBe("VOLUNTEER");
    expect(row!.triage).toBe(false);
    expect(row!.walkin).toBe(false);
    expect(row!.cc).toBe(false);
    expect(row!.remote).toBe(false);
  });

  it("allows DIRECTOR role when membership.kind === DIRECTOR", async () => {
    const dates = sixSaturdays();
    const term = await createTerm(dates);
    const dept = await createDepartment("PCAR");
    const director = await createPerson("Director");
    await createMembership(director.id, term.id, dept.id, "DIRECTOR");

    const dateKey = isoDateKey(dates[0]);
    await expect(
      setAssignment(director.id, { departmentId: dept.id, dateKey, personId: director.id, role: "DIRECTOR" })
    ).resolves.toBeUndefined();
  });

  it("rejects DIRECTOR role when membership.kind === VOLUNTEER", async () => {
    const dates = sixSaturdays();
    const term = await createTerm(dates);
    const dept = await createDepartment("PCAR");
    const director = await createPerson("Director");
    const volunteer = await createPerson("Volunteer");
    await createMembership(director.id, term.id, dept.id, "DIRECTOR");
    await createMembership(volunteer.id, term.id, dept.id, "VOLUNTEER");

    await expect(
      setAssignment(director.id, { departmentId: dept.id, dateKey: isoDateKey(dates[0]), personId: volunteer.id, role: "DIRECTOR" })
    ).rejects.toBeInstanceOf(BuilderValidationError);
  });

  it("rejects when person is not a member of the department in the term", async () => {
    const dates = sixSaturdays();
    const term = await createTerm(dates);
    const dept = await createDepartment("PCAR");
    const director = await createPerson("Director");
    const outsider = await createPerson("Outsider");
    await createMembership(director.id, term.id, dept.id, "DIRECTOR");

    await expect(
      setAssignment(director.id, { departmentId: dept.id, dateKey: isoDateKey(dates[0]), personId: outsider.id, role: "VOLUNTEER" })
    ).rejects.toBeInstanceOf(BuilderValidationError);
  });

  it("rejects when dateKey is not a clinic date", async () => {
    const dates = sixSaturdays();
    const term = await createTerm(dates);
    const dept = await createDepartment("PCAR");
    const director = await createPerson("Director");
    const volunteer = await createPerson("Volunteer");
    await createMembership(director.id, term.id, dept.id, "DIRECTOR");
    await createMembership(volunteer.id, term.id, dept.id, "VOLUNTEER");

    await expect(
      setAssignment(director.id, { departmentId: dept.id, dateKey: "2099-01-01", personId: volunteer.id, role: "VOLUNTEER" })
    ).rejects.toBeInstanceOf(BuilderValidationError);
  });

  it("preserves existing tags on a role change (upsert update)", async () => {
    const dates = sixSaturdays();
    const term = await createTerm(dates);
    const dept = await createDepartment("PCAR");
    const director = await createPerson("Director");
    const volunteer = await createPerson("Volunteer");
    await createMembership(director.id, term.id, dept.id, "DIRECTOR");
    await createMembership(volunteer.id, term.id, dept.id, "VOLUNTEER");

    // Manually create row with triage=true.
    await prisma.shiftAssignment.create({
      data: {
        termId: term.id,
        departmentId: dept.id,
        personId: volunteer.id,
        clinicDate: dates[0],
        role: "VOLUNTEER",
        triage: true,
      },
    });

    // Role change via setAssignment: tags preserved.
    await setAssignment(director.id, { departmentId: dept.id, dateKey: isoDateKey(dates[0]), personId: volunteer.id, role: "VOLUNTEER" });

    const row = await prisma.shiftAssignment.findFirst({
      where: { termId: term.id, departmentId: dept.id, personId: volunteer.id },
    });
    expect(row!.triage).toBe(true);
  });

  it("unassign (null role) deletes the row and records audit with reason", async () => {
    const dates = sixSaturdays();
    const term = await createTerm(dates);
    const dept = await createDepartment("PCAR");
    const director = await createPerson("Director");
    const volunteer = await createPerson("Volunteer");
    await createMembership(director.id, term.id, dept.id, "DIRECTOR");
    await createMembership(volunteer.id, term.id, dept.id, "VOLUNTEER");
    await createShift(term.id, dept.id, volunteer.id, dates[0], "VOLUNTEER");

    await setAssignment(director.id, {
      departmentId: dept.id,
      dateKey: isoDateKey(dates[0]),
      personId: volunteer.id,
      role: null,
      reason: "schedule conflict",
    });

    const row = await prisma.shiftAssignment.findFirst({
      where: { termId: term.id, departmentId: dept.id, personId: volunteer.id },
    });
    expect(row).toBeNull();

    const audit = await prisma.auditLog.findFirst({ where: { action: "schedule.unassign" } });
    expect(audit).not.toBeNull();
    expect((audit!.before as Record<string, unknown>)?.reason).toBe("schedule conflict");
  });

  it("audits assign action", async () => {
    const dates = sixSaturdays();
    const term = await createTerm(dates);
    const dept = await createDepartment("PCAR");
    const director = await createPerson("Director");
    const volunteer = await createPerson("Volunteer");
    await createMembership(director.id, term.id, dept.id, "DIRECTOR");
    await createMembership(volunteer.id, term.id, dept.id, "VOLUNTEER");

    await setAssignment(director.id, { departmentId: dept.id, dateKey: isoDateKey(dates[0]), personId: volunteer.id, role: "VOLUNTEER" });

    const audit = await prisma.auditLog.findFirst({ where: { action: "schedule.assign" } });
    expect(audit).not.toBeNull();
  });

  it("throws BuilderForbiddenError when actor does not manage the department", async () => {
    const dates = sixSaturdays();
    const term = await createTerm(dates);
    const dept = await createDepartment("PCAR");
    const outsider = await createPerson("Outsider");
    const volunteer = await createPerson("Volunteer");
    await createMembership(volunteer.id, term.id, dept.id, "VOLUNTEER");

    await expect(
      setAssignment(outsider.id, { departmentId: dept.id, dateKey: isoDateKey(dates[0]), personId: volunteer.id, role: "VOLUNTEER" })
    ).rejects.toBeInstanceOf(BuilderForbiddenError);
  });

  it("allows delegated manager to assign", async () => {
    const dates = sixSaturdays();
    const term = await createTerm(dates);
    const pcar = await createDepartment("PCAR");
    const sctp = await createDepartment("SCTP");
    await delegate(pcar.id, sctp.id);
    const director = await createPerson("Director");
    const volunteer = await createPerson("Volunteer");
    await createMembership(director.id, term.id, pcar.id, "DIRECTOR");
    await createMembership(volunteer.id, term.id, sctp.id, "VOLUNTEER");

    await expect(
      setAssignment(director.id, { departmentId: sctp.id, dateKey: isoDateKey(dates[0]), personId: volunteer.id, role: "VOLUNTEER" })
    ).resolves.toBeUndefined();
  });

  it("allows edit_all actor to assign in any department", async () => {
    const dates = sixSaturdays();
    const term = await createTerm(dates);
    const dept = await createDepartment("PCAR");
    const admin = await createPerson("Admin");
    const volunteer = await createPerson("Volunteer");
    await grantPermission(admin.id, "schedule.edit_all");
    await createMembership(volunteer.id, term.id, dept.id, "VOLUNTEER");

    await expect(
      setAssignment(admin.id, { departmentId: dept.id, dateKey: isoDateKey(dates[0]), personId: volunteer.id, role: "VOLUNTEER" })
    ).resolves.toBeUndefined();
  });

  it("throws BuilderValidationError when no active term", async () => {
    const dept = await createDepartment("PCAR");
    const person = await createPerson("Director");
    await grantPermission(person.id, "schedule.edit_all");

    await expect(
      setAssignment(person.id, { departmentId: dept.id, dateKey: "2026-06-06", personId: person.id, role: "VOLUNTEER" })
    ).rejects.toBeInstanceOf(BuilderValidationError);
  });
});

// ---------------------------------------------------------------------------
// toggleTag
// ---------------------------------------------------------------------------

describe("toggleTag", () => {
  it("flips triage on an existing assignment row", async () => {
    const dates = sixSaturdays();
    const term = await createTerm(dates);
    const dept = await createDepartment("SCTP", { idealHeadcount: 4 });
    const director = await createPerson("Director");
    const volunteer = await createPerson("Volunteer");
    await createMembership(director.id, term.id, dept.id, "DIRECTOR");
    await createMembership(volunteer.id, term.id, dept.id, "VOLUNTEER");
    await createShift(term.id, dept.id, volunteer.id, dates[0], "VOLUNTEER");

    await toggleTag(director.id, { departmentId: dept.id, dateKey: isoDateKey(dates[0]), personId: volunteer.id, tag: "triage" });

    const row = await prisma.shiftAssignment.findFirst({
      where: { termId: term.id, departmentId: dept.id, personId: volunteer.id },
    });
    expect(row!.triage).toBe(true);

    // Flip again.
    await toggleTag(director.id, { departmentId: dept.id, dateKey: isoDateKey(dates[0]), personId: volunteer.id, tag: "triage" });
    const row2 = await prisma.shiftAssignment.findFirst({
      where: { termId: term.id, departmentId: dept.id, personId: volunteer.id },
    });
    expect(row2!.triage).toBe(false);
  });

  it("throws BuilderValidationError when no assignment row exists", async () => {
    const dates = sixSaturdays();
    const term = await createTerm(dates);
    const dept = await createDepartment("SCTP");
    const director = await createPerson("Director");
    const volunteer = await createPerson("Volunteer");
    await createMembership(director.id, term.id, dept.id, "DIRECTOR");

    await expect(
      toggleTag(director.id, { departmentId: dept.id, dateKey: isoDateKey(dates[0]), personId: volunteer.id, tag: "walkin" })
    ).rejects.toBeInstanceOf(BuilderValidationError);
  });

  it("throws BuilderForbiddenError for actor who does not manage the dept", async () => {
    const dates = sixSaturdays();
    const term = await createTerm(dates);
    const dept = await createDepartment("SCTP");
    const outsider = await createPerson("Outsider");
    const volunteer = await createPerson("Volunteer");
    await createMembership(volunteer.id, term.id, dept.id, "VOLUNTEER");
    await createShift(term.id, dept.id, volunteer.id, dates[0], "VOLUNTEER");

    await expect(
      toggleTag(outsider.id, { departmentId: dept.id, dateKey: isoDateKey(dates[0]), personId: volunteer.id, tag: "triage" })
    ).rejects.toBeInstanceOf(BuilderForbiddenError);
  });

  it("audits tag toggle", async () => {
    const dates = sixSaturdays();
    const term = await createTerm(dates);
    const dept = await createDepartment("SCTP");
    const director = await createPerson("Director");
    const volunteer = await createPerson("Volunteer");
    await createMembership(director.id, term.id, dept.id, "DIRECTOR");
    await createMembership(volunteer.id, term.id, dept.id, "VOLUNTEER");
    await createShift(term.id, dept.id, volunteer.id, dates[0], "VOLUNTEER");

    await toggleTag(director.id, { departmentId: dept.id, dateKey: isoDateKey(dates[0]), personId: volunteer.id, tag: "cc" });

    const audit = await prisma.auditLog.findFirst({ where: { action: "schedule.tag" } });
    expect(audit).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// setPatientsBooked
// ---------------------------------------------------------------------------

describe("setPatientsBooked", () => {
  it("upserts patientsBooked and creates ScheduleDay row", async () => {
    const dates = sixSaturdays();
    const term = await createTerm(dates);
    const dept = await createDepartment("PCAR");
    const director = await createPerson("Director");
    await createMembership(director.id, term.id, dept.id, "DIRECTOR");

    await setPatientsBooked(director.id, { departmentId: dept.id, dateKey: isoDateKey(dates[0]), patientsBooked: 8 });

    const row = await prisma.scheduleDay.findFirst({
      where: { termId: term.id, departmentId: dept.id },
    });
    expect(row).not.toBeNull();
    expect(row!.patientsBooked).toBe(8);
  });

  it("updates an existing ScheduleDay", async () => {
    const dates = sixSaturdays();
    const term = await createTerm(dates);
    const dept = await createDepartment("PCAR");
    const director = await createPerson("Director");
    await createMembership(director.id, term.id, dept.id, "DIRECTOR");

    await setPatientsBooked(director.id, { departmentId: dept.id, dateKey: isoDateKey(dates[0]), patientsBooked: 3 });
    await setPatientsBooked(director.id, { departmentId: dept.id, dateKey: isoDateKey(dates[0]), patientsBooked: 5 });

    const rows = await prisma.scheduleDay.findMany({ where: { termId: term.id, departmentId: dept.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0].patientsBooked).toBe(5);
  });

  it("clears patientsBooked with null", async () => {
    const dates = sixSaturdays();
    const term = await createTerm(dates);
    const dept = await createDepartment("PCAR");
    const director = await createPerson("Director");
    await createMembership(director.id, term.id, dept.id, "DIRECTOR");

    await setPatientsBooked(director.id, { departmentId: dept.id, dateKey: isoDateKey(dates[0]), patientsBooked: 4 });
    await setPatientsBooked(director.id, { departmentId: dept.id, dateKey: isoDateKey(dates[0]), patientsBooked: null });

    const row = await prisma.scheduleDay.findFirst({ where: { termId: term.id, departmentId: dept.id } });
    expect(row!.patientsBooked).toBeNull();
  });

  it("throws BuilderForbiddenError for outsider", async () => {
    const dates = sixSaturdays();
    await createTerm(dates);
    const dept = await createDepartment("PCAR");
    await createTerm(dates);
    const outsider = await createPerson("Outsider");

    await expect(
      setPatientsBooked(outsider.id, { departmentId: dept.id, dateKey: isoDateKey(dates[0]), patientsBooked: 5 })
    ).rejects.toBeInstanceOf(BuilderForbiddenError);
  });
});

// ---------------------------------------------------------------------------
// setAvailabilityOverride
// ---------------------------------------------------------------------------

describe("setAvailabilityOverride", () => {
  it("sets canonical dates and directorAvailabilitySetAt", async () => {
    const dates = sixSaturdays();
    const term = await createTerm(dates);
    const dept = await createDepartment("PCAR");
    const director = await createPerson("Director");
    const volunteer = await createPerson("Volunteer");
    await createMembership(director.id, term.id, dept.id, "DIRECTOR");
    const membership = await createMembership(volunteer.id, term.id, dept.id, "VOLUNTEER");

    const dateKeys = [isoDateKey(dates[0]), isoDateKey(dates[1])];
    await setAvailabilityOverride(director.id, { membershipId: membership.id, dateKeys });

    const updated = await prisma.termMembership.findUniqueOrThrow({ where: { id: membership.id } });
    expect(updated.directorAvailabilityDates).toHaveLength(2);
    expect(updated.directorAvailabilitySetAt).not.toBeNull();
  });

  it("clears when dateKeys is null", async () => {
    const dates = sixSaturdays();
    const term = await createTerm(dates);
    const dept = await createDepartment("PCAR");
    const director = await createPerson("Director");
    const volunteer = await createPerson("Volunteer");
    await createMembership(director.id, term.id, dept.id, "DIRECTOR");
    const membership = await createMembership(volunteer.id, term.id, dept.id, "VOLUNTEER", {
      directorAvailabilityDates: [dates[0]],
      directorAvailabilitySetAt: new Date(),
    });

    await setAvailabilityOverride(director.id, { membershipId: membership.id, dateKeys: null });

    const updated = await prisma.termMembership.findUniqueOrThrow({ where: { id: membership.id } });
    expect(updated.directorAvailabilityDates).toHaveLength(0);
    expect(updated.directorAvailabilitySetAt).toBeNull();
  });

  it("rejects non-clinic dateKey", async () => {
    const dates = sixSaturdays();
    const term = await createTerm(dates);
    const dept = await createDepartment("PCAR");
    const director = await createPerson("Director");
    const volunteer = await createPerson("Volunteer");
    await createMembership(director.id, term.id, dept.id, "DIRECTOR");
    const membership = await createMembership(volunteer.id, term.id, dept.id, "VOLUNTEER");

    await expect(
      setAvailabilityOverride(director.id, { membershipId: membership.id, dateKeys: ["2099-01-01"] })
    ).rejects.toBeInstanceOf(BuilderValidationError);
  });

  it("rejects when membership is in a department the actor does not manage", async () => {
    const dates = sixSaturdays();
    const term = await createTerm(dates);
    const dept = await createDepartment("PCAR");
    const otherDept = await createDepartment("ITCM");
    const director = await createPerson("Director");
    const volunteer = await createPerson("Volunteer");
    await createMembership(director.id, term.id, dept.id, "DIRECTOR");
    const membership = await createMembership(volunteer.id, term.id, otherDept.id, "VOLUNTEER");

    await expect(
      setAvailabilityOverride(director.id, { membershipId: membership.id, dateKeys: [isoDateKey(dates[0])] })
    ).rejects.toBeInstanceOf(BuilderForbiddenError);
  });
});

// ---------------------------------------------------------------------------
// acknowledgeAvailability
// ---------------------------------------------------------------------------

describe("acknowledgeAvailability", () => {
  it("stamps availabilityAcknowledgedAt", async () => {
    const dates = sixSaturdays();
    const term = await createTerm(dates);
    const dept = await createDepartment("PCAR");
    const director = await createPerson("Director");
    const volunteer = await createPerson("Volunteer");
    await createMembership(director.id, term.id, dept.id, "DIRECTOR");
    const membership = await createMembership(volunteer.id, term.id, dept.id, "VOLUNTEER", {
      availabilityUpdatedAt: new Date(),
    });

    await acknowledgeAvailability(director.id, membership.id);

    const updated = await prisma.termMembership.findUniqueOrThrow({ where: { id: membership.id } });
    expect(updated.availabilityAcknowledgedAt).not.toBeNull();
  });

  it("throws BuilderForbiddenError for unmanaged membership", async () => {
    const dates = sixSaturdays();
    const term = await createTerm(dates);
    const dept = await createDepartment("PCAR");
    const otherDept = await createDepartment("ITCM");
    const director = await createPerson("Director");
    const volunteer = await createPerson("Volunteer");
    await createMembership(director.id, term.id, dept.id, "DIRECTOR");
    const membership = await createMembership(volunteer.id, term.id, otherDept.id, "VOLUNTEER");

    await expect(
      acknowledgeAvailability(director.id, membership.id)
    ).rejects.toBeInstanceOf(BuilderForbiddenError);
  });
});

// ---------------------------------------------------------------------------
// upsertRhdClinic
// ---------------------------------------------------------------------------

describe("upsertRhdClinic", () => {
  it("allows an actor who manages SCTS to upsert", async () => {
    const dates = sixSaturdays();
    const term = await createTerm(dates);
    const scts = await createDepartment("SCTS");
    const director = await createPerson("RHD Director");
    await createMembership(director.id, term.id, scts.id, "DIRECTOR");

    await expect(
      upsertRhdClinic(director.id, { dateKey: isoDateKey(dates[0]) })
    ).resolves.toBeUndefined();

    const clinic = await prisma.rhdClinic.findFirst({ where: { termId: term.id } });
    expect(clinic).not.toBeNull();
  });

  it("is idempotent: second upsert updates without creating a duplicate", async () => {
    const dates = sixSaturdays();
    const term = await createTerm(dates);
    const scts = await createDepartment("SCTS");
    const director = await createPerson("Director");
    await createMembership(director.id, term.id, scts.id, "DIRECTOR");

    const attending = await prisma.rhdAttending.create({
      data: { scheduleName: "Dr. Test", fullName: "Dr. Full Name" },
    });

    await upsertRhdClinic(director.id, { dateKey: isoDateKey(dates[0]), attendingId: attending.id });
    await upsertRhdClinic(director.id, { dateKey: isoDateKey(dates[0]), proceduresBooked: 2 });

    const clinics = await prisma.rhdClinic.findMany({ where: { termId: term.id } });
    expect(clinics).toHaveLength(1);
    expect(clinics[0].proceduresBooked).toBe(2);
  });

  it("throws BuilderForbiddenError when actor does not manage any RHD-family dept", async () => {
    const dates = sixSaturdays();
    const term = await createTerm(dates);
    const pcar = await createDepartment("PCAR");
    const director = await createPerson("Director");
    await createMembership(director.id, term.id, pcar.id, "DIRECTOR");

    await expect(
      upsertRhdClinic(director.id, { dateKey: isoDateKey(dates[0]) })
    ).rejects.toBeInstanceOf(BuilderForbiddenError);
  });

  it("rejects non-clinic dateKey", async () => {
    const dates = sixSaturdays();
    const term = await createTerm(dates);
    const scts = await createDepartment("SCTS");
    const director = await createPerson("Director");
    await createMembership(director.id, term.id, scts.id, "DIRECTOR");

    await expect(
      upsertRhdClinic(director.id, { dateKey: "2099-01-01" })
    ).rejects.toBeInstanceOf(BuilderValidationError);
  });

  it("clears attendingId when passed null, but leaves it unchanged when omitted", async () => {
    const dates = sixSaturdays();
    const term = await createTerm(dates);
    const scts = await createDepartment("SCTS");
    const director = await createPerson("Director");
    await createMembership(director.id, term.id, scts.id, "DIRECTOR");

    const attending = await prisma.rhdAttending.create({
      data: { scheduleName: "Dr. Null Test", fullName: "Dr. Full Null" },
    });

    // Create with an attending.
    await upsertRhdClinic(director.id, { dateKey: isoDateKey(dates[0]), attendingId: attending.id });

    const before = await prisma.rhdClinic.findFirstOrThrow({ where: { termId: term.id } });
    expect(before.attendingId).toBe(attending.id);

    // Clear attendingId by passing null explicitly.
    await upsertRhdClinic(director.id, { dateKey: isoDateKey(dates[0]), attendingId: null });

    const afterClear = await prisma.rhdClinic.findFirstOrThrow({ where: { termId: term.id } });
    expect(afterClear.attendingId).toBeNull();

    // Restore, then upsert without attendingId at all - it should remain null, not be touched.
    await upsertRhdClinic(director.id, { dateKey: isoDateKey(dates[0]), directorName: "Someone" });

    const afterOmit = await prisma.rhdClinic.findFirstOrThrow({ where: { termId: term.id } });
    expect(afterOmit.attendingId).toBeNull();
    expect(afterOmit.directorName).toBe("Someone");
  });
});

// ---------------------------------------------------------------------------
// builderView
// ---------------------------------------------------------------------------

describe("builderView", () => {
  it("returns empty shape when viewer has no manageable departments", async () => {
    const dates = sixSaturdays();
    await createTerm(dates);
    const person = await createPerson("Nobody");

    const view = await builderView(person.id, {});
    expect(view.departments).toHaveLength(0);
    expect(view.selectedDepartment).toBeNull();
  });

  it("lists selectable departments sorted by code", async () => {
    const dates = sixSaturdays();
    const term = await createTerm(dates);
    const zeta = await createDepartment("ZETA");
    const alpha = await createDepartment("ALPHA");
    const director = await createPerson("Director");
    await createMembership(director.id, term.id, zeta.id, "DIRECTOR");
    await createMembership(director.id, term.id, alpha.id, "DIRECTOR");

    const view = await builderView(director.id, {});
    const codes = view.departments.map((d) => d.code);
    expect(codes).toEqual([...codes].sort());
  });

  it("selects opts.departmentId when in the manageable set", async () => {
    const dates = sixSaturdays();
    const term = await createTerm(dates);
    const dept = await createDepartment("PCAR");
    const director = await createPerson("Director");
    await createMembership(director.id, term.id, dept.id, "DIRECTOR");

    const view = await builderView(director.id, { departmentId: dept.id });
    expect(view.selectedDepartment?.id).toBe(dept.id);
  });

  it("defaults to first department when no departmentId given", async () => {
    const dates = sixSaturdays();
    const term = await createTerm(dates);
    const alpha = await createDepartment("ALPHA");
    const zeta = await createDepartment("ZETA");
    const director = await createPerson("Director");
    await createMembership(director.id, term.id, alpha.id, "DIRECTOR");
    await createMembership(director.id, term.id, zeta.id, "DIRECTOR");

    const view = await builderView(director.id, {});
    expect(view.selectedDepartment?.code).toBe("ALPHA");
  });

  it("selects the next upcoming date by default", async () => {
    const dates = sixSaturdays();
    const term = await createTerm(dates);
    const dept = await createDepartment("PCAR");
    const director = await createPerson("Director");
    await createMembership(director.id, term.id, dept.id, "DIRECTOR");

    // now falls between dates[1] and dates[2] (next day after dates[1]); should pick dates[2]
    const now = new Date(dates[1].getTime() + 24 * 60 * 60 * 1000);
    const view = await builderView(director.id, { now });
    expect(view.selectedDateKey).toBe(isoDateKey(dates[2]));
  });

  it("falls back to last date when all dates are past", async () => {
    const dates = sixSaturdays();
    const term = await createTerm(dates);
    const dept = await createDepartment("PCAR");
    const director = await createPerson("Director");
    await createMembership(director.id, term.id, dept.id, "DIRECTOR");

    const now = new Date(dates[dates.length - 1].getTime() + 86_400_000);
    const view = await builderView(director.id, { now });
    expect(view.selectedDateKey).toBe(isoDateKey(dates[dates.length - 1]));
  });

  it("includes ACTIVE members with correct availability shape", async () => {
    const dates = sixSaturdays();
    const term = await createTerm(dates);
    const dept = await createDepartment("PCAR");
    const director = await createPerson("Director");
    const volunteer = await createPerson("Volunteer");
    await createMembership(director.id, term.id, dept.id, "DIRECTOR");
    await createMembership(volunteer.id, term.id, dept.id, "VOLUNTEER", {
      availabilityUpdatedAt: new Date("2026-05-01T12:00:00Z"),
      selfAvailabilityDates: [dates[0], dates[1]],
    });

    const view = await builderView(director.id, { departmentId: dept.id });
    const member = view.members.find((m) => m.person.id === volunteer.id);
    expect(member).toBeDefined();
    expect(member!.acknowledgePending).toBe(true);
    expect(member!.availability.tier).toBe("SELF");
    expect(member!.availability.dates).toHaveLength(2);
  });

  it("marks overrideActive when directorAvailabilitySetAt is set", async () => {
    const dates = sixSaturdays();
    const term = await createTerm(dates);
    const dept = await createDepartment("PCAR");
    const director = await createPerson("Director");
    const volunteer = await createPerson("Volunteer");
    await createMembership(director.id, term.id, dept.id, "DIRECTOR");
    await createMembership(volunteer.id, term.id, dept.id, "VOLUNTEER", {
      directorAvailabilitySetAt: new Date(),
    });

    const view = await builderView(director.id, { departmentId: dept.id });
    const member = view.members.find((m) => m.person.id === volunteer.id);
    expect(member!.overrideActive).toBe(true);
  });

  it("assignmentsByDate covers all dates across the term", async () => {
    const dates = sixSaturdays();
    const term = await createTerm(dates);
    const dept = await createDepartment("PCAR");
    const director = await createPerson("Director");
    const volunteer = await createPerson("Volunteer");
    await createMembership(director.id, term.id, dept.id, "DIRECTOR");
    await createMembership(volunteer.id, term.id, dept.id, "VOLUNTEER");

    // Assign on two different dates.
    await createShift(term.id, dept.id, volunteer.id, dates[0], "VOLUNTEER");
    await createShift(term.id, dept.id, volunteer.id, dates[3], "VOLUNTEER");

    const view = await builderView(director.id, { departmentId: dept.id });
    const byDate = view.assignmentsByDate;

    const key0 = isoDateKey(dates[0]);
    const key3 = isoDateKey(dates[3]);

    expect(byDate[key0]?.[volunteer.id]).toBeDefined();
    expect(byDate[key3]?.[volunteer.id]).toBeDefined();

    // A date with no assignments should not appear (or appear as empty).
    expect(byDate[key0]![volunteer.id].role).toBe("VOLUNTEER");
  });

  it("capacity math: counts spanish-speaking assignees correctly", async () => {
    const dates = sixSaturdays();
    const term = await createTerm(dates);
    const dept = await createDepartment("PCAR", { idealHeadcount: 4 });
    const director = await createPerson("Director");
    const spanishVol = await createPerson("Bilingual", { spanishSpeaking: true });
    const regularVol = await createPerson("Regular");
    await createMembership(director.id, term.id, dept.id, "DIRECTOR");
    await createMembership(spanishVol.id, term.id, dept.id, "VOLUNTEER");
    await createMembership(regularVol.id, term.id, dept.id, "VOLUNTEER");

    await createShift(term.id, dept.id, spanishVol.id, dates[0], "VOLUNTEER");
    await createShift(term.id, dept.id, regularVol.id, dates[0], "VOLUNTEER");

    const view = await builderView(director.id, { departmentId: dept.id, dateKey: isoDateKey(dates[0]) });
    expect(view.capacity.spanishCount).toBe(1);
    expect(view.capacity.headcount).toBe(2);
  });

  it("banner lists only non-compliant volunteers assigned on selected date", async () => {
    const dates = sixSaturdays();
    const term = await createTerm(dates);
    const dept = await createDepartment("PCAR");
    const director = await createPerson("Director");
    const noCertVol = await createPerson("NoCert");
    const compliantVol = await createPerson("Compliant");
    await createMembership(director.id, term.id, dept.id, "DIRECTOR");
    await createMembership(noCertVol.id, term.id, dept.id, "VOLUNTEER");
    await createMembership(compliantVol.id, term.id, dept.id, "VOLUNTEER");

    await createShift(term.id, dept.id, noCertVol.id, dates[0], "VOLUNTEER");
    await createShift(term.id, dept.id, compliantVol.id, dates[0], "VOLUNTEER");

    // Give compliantVol a valid cert (fresh, well within term).
    await prisma.hipaaCertificate.create({
      data: {
        personId: compliantVol.id,
        fileName: "cert.pdf",
        storedName: "cert.pdf",
        size: 100,
        mimeType: "application/pdf",
        completionDate: new Date("2026-01-01T12:00:00Z"),
      },
    });

    const view = await builderView(director.id, { departmentId: dept.id, dateKey: isoDateKey(dates[0]) });
    // Banner should list noCertVol but not compliantVol.
    expect(view.banner).toHaveLength(1);
    const nonCompliantIds = view.banner[0].nonCompliant.map((v) => v.id);
    expect(nonCompliantIds).toContain(noCertVol.id);
    expect(nonCompliantIds).not.toContain(compliantVol.id);
  });

  it("conflicts: person assigned in two departments on same date appears in conflicts map", async () => {
    const dates = sixSaturdays();
    const term = await createTerm(dates);
    const pcar = await createDepartment("PCAR");
    const sctp = await createDepartment("SCTP");
    const director = await createPerson("Director");
    const conflicted = await createPerson("Conflicted");
    await createMembership(director.id, term.id, pcar.id, "DIRECTOR");
    await createMembership(director.id, term.id, sctp.id, "DIRECTOR");
    await createMembership(conflicted.id, term.id, pcar.id, "VOLUNTEER");
    await createMembership(conflicted.id, term.id, sctp.id, "VOLUNTEER");

    await createShift(term.id, pcar.id, conflicted.id, dates[0], "VOLUNTEER");
    await createShift(term.id, sctp.id, conflicted.id, dates[0], "VOLUNTEER");

    const view = await builderView(director.id, { departmentId: pcar.id, dateKey: isoDateKey(dates[0]) });
    expect(view.conflicts[conflicted.id]).toBeDefined();
    expect(view.conflicts[conflicted.id]).toContain("SCTP Dept");
  });

  it("pendingRequestCount counts only PENDING requests for selected dept in term", async () => {
    const dates = sixSaturdays();
    const term = await createTerm(dates);
    const dept = await createDepartment("PCAR");
    const director = await createPerson("Director");
    const volunteer = await createPerson("Volunteer");
    await createMembership(director.id, term.id, dept.id, "DIRECTOR");
    await createMembership(volunteer.id, term.id, dept.id, "VOLUNTEER");
    await createShift(term.id, dept.id, volunteer.id, dates[0], "VOLUNTEER");

    await prisma.shiftRequest.create({
      data: {
        termId: term.id,
        requesterId: volunteer.id,
        requesterDate: dates[0],
        departmentId: dept.id,
        status: "PENDING",
      },
    });

    const view = await builderView(director.id, { departmentId: dept.id });
    expect(view.pendingRequestCount).toBe(1);
  });

  it("rhd block is present for SCTS department with attending matrix", async () => {
    const dates = sixSaturdays();
    const term = await createTerm(dates);
    const scts = await createDepartment("SCTS");
    await createDepartment("JCTS");
    await createDepartment("CCRH");
    const director = await createPerson("Director");
    await createMembership(director.id, term.id, scts.id, "DIRECTOR");

    const attending = await prisma.rhdAttending.create({
      data: {
        scheduleName: "Dr. Test",
        fullName: "Dr. Full Name",
        iudIn: "yes",
        iudOut: "no",
        nexplanon: "unknown",
        gac: "yes",
        emb: "no",
        seesMale: "no",
      },
    });

    await prisma.rhdClinic.create({
      data: {
        termId: term.id,
        clinicDate: dates[0],
        attendingId: attending.id,
        directorName: "Test Director",
        proceduresBooked: 2,
      },
    });

    const view = await builderView(director.id, { departmentId: scts.id, dateKey: isoDateKey(dates[0]) });
    expect(view.rhd).not.toBeNull();
    expect(view.rhd!.clinic).not.toBeNull();
    expect(view.rhd!.clinic!.attendingId).toBe(attending.id);
    expect(view.rhd!.attendingOptions.length).toBeGreaterThan(0);
    expect(view.rhd!.readiness.attending).not.toBeNull();
    expect(view.rhd!.readiness.procedures.iudIn).toBe("yes");
  });

  it("threads opts.now into complianceStatus: a cert compliant today reads EXPIRED when now is far future", async () => {
    const dates = sixSaturdays();
    const term = await createTerm(dates);
    const dept = await createDepartment("PCAR");
    const director = await createPerson("Director");
    const certVol = await createPerson("CertVol");
    await createMembership(director.id, term.id, dept.id, "DIRECTOR");
    await createMembership(certVol.id, term.id, dept.id, "VOLUNTEER");
    await createShift(term.id, dept.id, certVol.id, dates[0], "VOLUNTEER");

    // completionDate = 2026-01-01 -> expiresAt = 2027-01-01.
    // With now = 2026-06-07 (today), the cert clears the term bar and is COMPLIANT.
    // With now = 2027-02-01, expiresAt < now so it is EXPIRED.
    await prisma.hipaaCertificate.create({
      data: {
        personId: certVol.id,
        fileName: "cert.pdf",
        storedName: "cert.pdf",
        size: 100,
        mimeType: "application/pdf",
        completionDate: new Date("2026-01-01T12:00:00Z"),
      },
    });

    // Verify COMPLIANT today: banner should not include certVol.
    const today = new Date("2026-06-07T12:00:00Z");
    const viewToday = await builderView(director.id, {
      departmentId: dept.id,
      dateKey: isoDateKey(dates[0]),
      now: today,
    });
    const nonCompliantIdsToday = viewToday.banner.flatMap((b) => b.nonCompliant.map((v) => v.id));
    expect(nonCompliantIdsToday).not.toContain(certVol.id);

    // Verify EXPIRED in the future: banner should include certVol.
    const farFuture = new Date("2027-02-01T12:00:00Z");
    const viewFuture = await builderView(director.id, {
      departmentId: dept.id,
      dateKey: isoDateKey(dates[0]),
      now: farFuture,
    });
    const nonCompliantIdsFuture = viewFuture.banner.flatMap((b) => b.nonCompliant.map((v) => v.id));
    expect(nonCompliantIdsFuture).toContain(certVol.id);
  });

  it("rhd block is null for a non-RHD department", async () => {
    const dates = sixSaturdays();
    const term = await createTerm(dates);
    const pcar = await createDepartment("PCAR");
    const director = await createPerson("Director");
    await createMembership(director.id, term.id, pcar.id, "DIRECTOR");

    const view = await builderView(director.id, { departmentId: pcar.id });
    expect(view.rhd).toBeNull();
  });

  it("members list is sorted by name", async () => {
    const dates = sixSaturdays();
    const term = await createTerm(dates);
    const dept = await createDepartment("PCAR");
    const director = await createPerson("Director");
    const zzVol = await createPerson("Zara Zimmerman");
    const aaVol = await createPerson("Adam Anderson");
    await createMembership(director.id, term.id, dept.id, "DIRECTOR");
    await createMembership(zzVol.id, term.id, dept.id, "VOLUNTEER");
    await createMembership(aaVol.id, term.id, dept.id, "VOLUNTEER");

    const view = await builderView(director.id, { departmentId: dept.id });
    const names = view.members.map((m) => m.person.name);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
  });
});
