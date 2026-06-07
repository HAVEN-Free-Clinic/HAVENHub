/**
 * Integration tests for the schedule service.
 *
 * mySchedule:
 *   - Returns shifts with tags + department, ordered by clinicDate asc.
 *   - Availability resolves SELF tier after a self-update.
 *   - legacyNote surfaces when selfUpdatedAvailability is set on a membership.
 *   - No active term returns the all-empty shape.
 *   - No membership: availability null, legacyNote null; shifts still returned if any.
 *
 * fullSchedule:
 *   - dateKey param selects the correct Saturday.
 *   - Default picks the next upcoming date vs injected now.
 *   - past-all-dates fallback picks the last clinicDate.
 *   - Grouping: directors, volunteers, shadows in the right buckets with tags.
 *   - Conflict: a person assigned in two departments on the SAME Saturday gets
 *     the other department name in both departments' conflict maps.
 *   - Person in another department on a DIFFERENT date does NOT appear in conflicts.
 *   - Departments sorted by code.
 *
 * updateMyAvailability:
 *   - Happy path updates BOTH memberships of a two-dept person, clears
 *     acknowledgedAt, stores canonical noon-UTC dates, writes one audit row.
 *   - Non-clinic date rejected listing the bad ISO day key.
 *   - No active membership rejects with AvailabilityValidationError.
 *   - Dedupe: same day passed twice stored once.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import {
  mySchedule,
  fullSchedule,
  updateMyAvailability,
  AvailabilityValidationError,
} from "./schedule";
import { isoDateKey } from "../engine/map";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function utc(year: number, month: number, day: number, hour = 12): Date {
  return new Date(Date.UTC(year, month - 1, day, hour, 0, 0, 0));
}

/** Returns an array of Saturday dates at 12:00 UTC starting on startIso. */
function saturdays(startIso: string, count: number): Date[] {
  const dates: Date[] = [];
  let d = new Date(`${startIso}T12:00:00Z`);
  // Advance to Saturday (day 6).
  while (d.getUTCDay() !== 6) d = new Date(d.getTime() + 86400000);
  for (let i = 0; i < count; i++) {
    dates.push(new Date(d));
    d = new Date(d.getTime() + 7 * 86400000);
  }
  return dates;
}

async function createPerson(name: string) {
  return prisma.person.create({ data: { name } });
}

async function createTerm(
  status: "ACTIVE" | "ARCHIVED" | "PLANNING" = "ACTIVE",
  code = "SU26",
  clinicDates: Date[] = []
) {
  return prisma.term.create({
    data: {
      code,
      name: `Term ${code}`,
      startDate: new Date("2026-05-30T12:00:00Z"),
      endDate: new Date("2026-09-26T12:00:00Z"),
      status,
      clinicDates,
    },
  });
}

async function createDepartment(code: string) {
  return prisma.department.upsert({
    where: { code },
    update: {},
    create: { code, name: `${code} Dept` },
  });
}

async function createMembership(
  personId: string,
  termId: string,
  departmentId: string,
  kind: "VOLUNTEER" | "DIRECTOR",
  opts: {
    status?: "ACTIVE" | "REMOVED";
    selfAvailabilityDates?: Date[];
    availabilityUpdatedAt?: Date | null;
    selfUpdatedAvailability?: string | null;
    availabilityAcknowledgedAt?: Date | null;
  } = {}
) {
  return prisma.termMembership.create({
    data: {
      personId,
      termId,
      departmentId,
      kind,
      status: opts.status ?? "ACTIVE",
      selfAvailabilityDates: opts.selfAvailabilityDates ?? [],
      availabilityUpdatedAt: opts.availabilityUpdatedAt ?? null,
      selfUpdatedAvailability: opts.selfUpdatedAvailability ?? null,
      availabilityAcknowledgedAt: opts.availabilityAcknowledgedAt ?? null,
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

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(resetDb);

// ---------------------------------------------------------------------------
// mySchedule
// ---------------------------------------------------------------------------

describe("mySchedule", () => {
  it("returns shifts with tags and department, ordered by clinicDate asc", async () => {
    const dates = saturdays("2026-05-30", 3); // [May 30, Jun 6, Jun 13]
    const term = await createTerm("ACTIVE", "SU26", dates);
    const dept = await createDepartment("ITCM");
    const person = await createPerson("Alice");
    await createMembership(person.id, term.id, dept.id, "VOLUNTEER");

    // Insert out of order to verify sort.
    await createShift(term.id, dept.id, person.id, dates[2], "VOLUNTEER", { triage: true });
    await createShift(term.id, dept.id, person.id, dates[0], "VOLUNTEER", { walkin: true, cc: true });

    const result = await mySchedule(person.id);

    expect(result.term?.id).toBe(term.id);
    expect(result.clinicDates).toHaveLength(3);
    expect(result.shifts).toHaveLength(2);
    // Ordered by clinicDate asc.
    expect(isoDateKey(result.shifts[0].clinicDate)).toBe(isoDateKey(dates[0]));
    expect(isoDateKey(result.shifts[1].clinicDate)).toBe(isoDateKey(dates[2]));
    // Tags on first shift.
    expect(result.shifts[0].tags.walkin).toBe(true);
    expect(result.shifts[0].tags.cc).toBe(true);
    expect(result.shifts[0].tags.triage).toBe(false);
    // Tags on second shift.
    expect(result.shifts[1].tags.triage).toBe(true);
    // Department attached.
    expect(result.shifts[0].department.code).toBe("ITCM");
  });

  it("resolves SELF tier after a self-update", async () => {
    const dates = saturdays("2026-05-30", 4);
    const term = await createTerm("ACTIVE", "SU26", dates);
    const dept = await createDepartment("ITCM");
    const person = await createPerson("Bob");

    const selfDates = [dates[0], dates[2]];
    await createMembership(person.id, term.id, dept.id, "VOLUNTEER", {
      selfAvailabilityDates: selfDates,
      availabilityUpdatedAt: utc(2026, 6, 1),
    });

    const result = await mySchedule(person.id);

    expect(result.availability).not.toBeNull();
    expect(result.availability?.tier).toBe("SELF");
    expect(result.availability?.dates).toHaveLength(2);
  });

  it("surfaces legacyNote from selfUpdatedAvailability", async () => {
    const dates = saturdays("2026-05-30", 2);
    const term = await createTerm("ACTIVE", "SU26", dates);
    const dept = await createDepartment("ITCM");
    const person = await createPerson("Carol");

    await createMembership(person.id, term.id, dept.id, "VOLUNTEER", {
      selfUpdatedAvailability: "All Saturdays",
    });

    const result = await mySchedule(person.id);

    expect(result.legacyNote).toBe("All Saturdays");
  });

  it("returns all-empty shape when no active term", async () => {
    await createTerm("ARCHIVED", "SU26", []);
    const person = await createPerson("Dave");

    const result = await mySchedule(person.id);

    expect(result.term).toBeNull();
    expect(result.shifts).toHaveLength(0);
    expect(result.availability).toBeNull();
    expect(result.legacyNote).toBeNull();
    expect(result.clinicDates).toHaveLength(0);
  });

  it("returns shifts but null availability and legacyNote when person has no membership", async () => {
    const dates = saturdays("2026-05-30", 2);
    const term = await createTerm("ACTIVE", "SU26", dates);
    const dept = await createDepartment("ITCM");
    const person = await createPerson("Eve");
    // No membership created, but still has a shift (edge case / manual assignment).
    await createShift(term.id, dept.id, person.id, dates[0], "VOLUNTEER");

    const result = await mySchedule(person.id);

    expect(result.shifts).toHaveLength(1);
    expect(result.availability).toBeNull();
    expect(result.legacyNote).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// fullSchedule
// ---------------------------------------------------------------------------

describe("fullSchedule", () => {
  it("dateKey param selects the correct Saturday", async () => {
    const dates = saturdays("2026-05-30", 4);
    const term = await createTerm("ACTIVE", "SU26", dates);
    const dept = await createDepartment("ITCM");
    const person = await createPerson("Alice");
    await createMembership(person.id, term.id, dept.id, "DIRECTOR");
    await createShift(term.id, dept.id, person.id, dates[2], "DIRECTOR");

    const key = isoDateKey(dates[2]);
    const result = await fullSchedule(key);

    expect(result.selectedDate).not.toBeNull();
    expect(isoDateKey(result.selectedDate!)).toBe(key);
  });

  it("default selects the next upcoming date when now is between two clinic dates", async () => {
    const dates = saturdays("2026-05-30", 3); // d[0], d[1], d[2]
    const term = await createTerm("ACTIVE", "SU26", dates);
    const dept = await createDepartment("ITCM");
    const person = await createPerson("Bob");
    await createMembership(person.id, term.id, dept.id, "VOLUNTEER");

    // now = one day after d[0] so d[1] is the next upcoming.
    const now = new Date(dates[0].getTime() + 86400000);
    const result = await fullSchedule(undefined, now);

    expect(result.selectedDate).not.toBeNull();
    expect(isoDateKey(result.selectedDate!)).toBe(isoDateKey(dates[1]));
  });

  it("past-all-dates fallback picks the last clinicDate", async () => {
    const dates = saturdays("2026-05-30", 3);
    const term = await createTerm("ACTIVE", "SU26", dates);
    const dept = await createDepartment("ITCM");
    const person = await createPerson("Carol");
    await createMembership(person.id, term.id, dept.id, "VOLUNTEER");

    // now = one week after the last date.
    const now = new Date(dates[2].getTime() + 7 * 86400000);
    const result = await fullSchedule(undefined, now);

    expect(result.selectedDate).not.toBeNull();
    expect(isoDateKey(result.selectedDate!)).toBe(isoDateKey(dates[2]));
  });

  it("groups directors, volunteers, shadows in the right buckets with tags", async () => {
    const dates = saturdays("2026-05-30", 1);
    const term = await createTerm("ACTIVE", "SU26", dates);
    const dept = await createDepartment("ITCM");

    const director = await createPerson("Director");
    const volunteer = await createPerson("Volunteer");
    const shadow = await createPerson("Shadow");

    await createMembership(director.id, term.id, dept.id, "DIRECTOR");
    await createMembership(volunteer.id, term.id, dept.id, "VOLUNTEER");
    await createMembership(shadow.id, term.id, dept.id, "VOLUNTEER");

    await createShift(term.id, dept.id, director.id, dates[0], "DIRECTOR");
    await createShift(term.id, dept.id, volunteer.id, dates[0], "VOLUNTEER", { triage: true });
    await createShift(term.id, dept.id, shadow.id, dates[0], "SHADOW");

    const result = await fullSchedule(isoDateKey(dates[0]));

    expect(result.departments).toHaveLength(1);
    const deptResult = result.departments[0];

    expect(deptResult.directors).toHaveLength(1);
    expect(deptResult.directors[0].name).toBe("Director");

    expect(deptResult.volunteers).toHaveLength(1);
    expect(deptResult.volunteers[0].name).toBe("Volunteer");
    expect(deptResult.volunteers[0].tags.triage).toBe(true);
    expect(deptResult.volunteers[0].tags.walkin).toBe(false);

    expect(deptResult.shadows).toHaveLength(1);
    expect(deptResult.shadows[0].name).toBe("Shadow");
  });

  it("conflict: person in two depts on the SAME Saturday appears in both conflict maps", async () => {
    const dates = saturdays("2026-05-30", 2);
    const term = await createTerm("ACTIVE", "SU26", dates);
    const deptA = await createDepartment("AABB");
    const deptB = await createDepartment("BBCC");

    const conflicted = await createPerson("Double Shift");

    await createMembership(conflicted.id, term.id, deptA.id, "VOLUNTEER");
    await createMembership(conflicted.id, term.id, deptB.id, "VOLUNTEER");

    // Same date in both departments.
    await createShift(term.id, deptA.id, conflicted.id, dates[0], "VOLUNTEER");
    await createShift(term.id, deptB.id, conflicted.id, dates[0], "VOLUNTEER");

    const result = await fullSchedule(isoDateKey(dates[0]));

    const deptAResult = result.departments.find((d) => d.department.code === "AABB");
    const deptBResult = result.departments.find((d) => d.department.code === "BBCC");

    expect(deptAResult).toBeDefined();
    expect(deptBResult).toBeDefined();

    // Conflicted person should appear in AABB's conflict map pointing to BBCC Dept.
    const aConflicts = deptAResult!.conflicts.get(conflicted.id);
    expect(aConflicts).toBeDefined();
    expect(aConflicts).toContain("BBCC Dept");

    // And vice versa.
    const bConflicts = deptBResult!.conflicts.get(conflicted.id);
    expect(bConflicts).toBeDefined();
    expect(bConflicts).toContain("AABB Dept");
  });

  it("person in another dept on a DIFFERENT date does not appear in conflicts", async () => {
    const dates = saturdays("2026-05-30", 2);
    const term = await createTerm("ACTIVE", "SU26", dates);
    const deptA = await createDepartment("AABB");
    const deptB = await createDepartment("BBCC");

    const person = await createPerson("No Conflict");

    await createMembership(person.id, term.id, deptA.id, "VOLUNTEER");
    await createMembership(person.id, term.id, deptB.id, "VOLUNTEER");

    // Different dates - no same-day conflict.
    await createShift(term.id, deptA.id, person.id, dates[0], "VOLUNTEER");
    await createShift(term.id, deptB.id, person.id, dates[1], "VOLUNTEER");

    // Select dates[0] - person is only in deptA that day.
    const result = await fullSchedule(isoDateKey(dates[0]));

    const deptAResult = result.departments.find((d) => d.department.code === "AABB");
    const aConflicts = deptAResult!.conflicts.get(person.id);
    // No same-day conflict for the selected date.
    expect(aConflicts ?? []).toHaveLength(0);
  });

  it("departments sorted by code", async () => {
    const dates = saturdays("2026-05-30", 1);
    const term = await createTerm("ACTIVE", "SU26", dates);
    await createDepartment("ZZZZ");
    await createDepartment("AAAA");
    await createDepartment("MMMM");

    // No shifts needed - all departments should still show up sorted.
    const result = await fullSchedule(isoDateKey(dates[0]));

    const codes = result.departments.map((d) => d.department.code);
    expect(codes).toEqual([...codes].sort());
  });

  it("no active term returns all-empty shape", async () => {
    await createTerm("ARCHIVED", "SU26", []);

    const result = await fullSchedule();

    expect(result.term).toBeNull();
    expect(result.clinicDates).toHaveLength(0);
    expect(result.selectedDate).toBeNull();
    expect(result.departments).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// updateMyAvailability
// ---------------------------------------------------------------------------

describe("updateMyAvailability", () => {
  it("happy path: updates both memberships of a two-dept person, clears acknowledgedAt, stores canonical noon-UTC dates, writes one audit row", async () => {
    const dates = saturdays("2026-05-30", 4);
    const term = await createTerm("ACTIVE", "SU26", dates);
    const deptA = await createDepartment("ITCM");
    const deptB = await createDepartment("SRR");
    const person = await createPerson("Alice");

    const memA = await createMembership(person.id, term.id, deptA.id, "VOLUNTEER", {
      availabilityAcknowledgedAt: utc(2026, 5, 1),
    });
    const memB = await createMembership(person.id, term.id, deptB.id, "VOLUNTEER", {
      availabilityAcknowledgedAt: utc(2026, 5, 1),
    });

    // Pass midnight UTC dates - service must store noon-UTC.
    const callerDates = [
      new Date(Date.UTC(2026, dates[0].getUTCMonth(), dates[0].getUTCDate(), 0, 0, 0)),
      new Date(Date.UTC(2026, dates[2].getUTCMonth(), dates[2].getUTCDate(), 0, 0, 0)),
    ];

    await updateMyAvailability(person.id, callerDates);

    const updatedA = await prisma.termMembership.findUniqueOrThrow({ where: { id: memA.id } });
    const updatedB = await prisma.termMembership.findUniqueOrThrow({ where: { id: memB.id } });

    // Both memberships updated.
    expect(updatedA.selfAvailabilityDates).toHaveLength(2);
    expect(updatedB.selfAvailabilityDates).toHaveLength(2);

    // Stored as noon-UTC canonical dates.
    for (const d of updatedA.selfAvailabilityDates) {
      expect(d.getUTCHours()).toBe(12);
    }
    for (const d of updatedB.selfAvailabilityDates) {
      expect(d.getUTCHours()).toBe(12);
    }

    // acknowledgedAt cleared.
    expect(updatedA.availabilityAcknowledgedAt).toBeNull();
    expect(updatedB.availabilityAcknowledgedAt).toBeNull();

    // updatedAt set.
    expect(updatedA.availabilityUpdatedAt).not.toBeNull();
    expect(updatedB.availabilityUpdatedAt).not.toBeNull();

    // One audit row.
    const auditRows = await prisma.auditLog.findMany({
      where: { action: "schedule.availability_update" },
    });
    expect(auditRows).toHaveLength(1);

    const auditRow = auditRows[0];
    expect(auditRow.entityType).toBe("TermMembership");
    expect(auditRow.entityId).toBe(memA.id);

    const after = auditRow.after as Record<string, unknown>;
    // membershipIds in after.
    expect(Array.isArray(after.membershipIds)).toBe(true);
    expect((after.membershipIds as string[]).sort()).toEqual([memA.id, memB.id].sort());

    // before/after as ISO day-key arrays.
    expect(Array.isArray(after.dates)).toBe(true);
    const before = auditRow.before as Record<string, unknown>;
    expect(Array.isArray(before.dates)).toBe(true);
  });

  it("rejects non-clinic date and lists the bad ISO day key", async () => {
    const dates = saturdays("2026-05-30", 2);
    const term = await createTerm("ACTIVE", "SU26", dates);
    const dept = await createDepartment("ITCM");
    const person = await createPerson("Bob");
    await createMembership(person.id, term.id, dept.id, "VOLUNTEER");

    // A Wednesday that is not a clinic date.
    const badDate = new Date(Date.UTC(2026, 6, 1, 0, 0, 0)); // 2026-07-01

    await expect(updateMyAvailability(person.id, [badDate])).rejects.toThrow("2026-07-01");
    await expect(updateMyAvailability(person.id, [badDate])).rejects.toBeInstanceOf(
      AvailabilityValidationError
    );
  });

  it("rejects with AvailabilityValidationError when person has no active membership in active term", async () => {
    const dates = saturdays("2026-05-30", 2);
    await createTerm("ACTIVE", "SU26", dates);
    const person = await createPerson("Carol");
    // No membership created.

    await expect(updateMyAvailability(person.id, [dates[0]])).rejects.toBeInstanceOf(
      AvailabilityValidationError
    );
    await expect(updateMyAvailability(person.id, [dates[0]])).rejects.toThrow(
      "not on the active term roster"
    );
  });

  it("deduplicates: same day passed twice is stored once", async () => {
    const dates = saturdays("2026-05-30", 2);
    const term = await createTerm("ACTIVE", "SU26", dates);
    const dept = await createDepartment("ITCM");
    const person = await createPerson("Dave");
    const mem = await createMembership(person.id, term.id, dept.id, "VOLUNTEER");

    // Pass dates[0] twice (one at midnight, one at noon - same UTC day).
    const midnight = new Date(Date.UTC(2026, dates[0].getUTCMonth(), dates[0].getUTCDate(), 0));
    const noon = new Date(Date.UTC(2026, dates[0].getUTCMonth(), dates[0].getUTCDate(), 12));

    await updateMyAvailability(person.id, [midnight, noon]);

    const updated = await prisma.termMembership.findUniqueOrThrow({ where: { id: mem.id } });
    expect(updated.selfAvailabilityDates).toHaveLength(1);
  });
});
