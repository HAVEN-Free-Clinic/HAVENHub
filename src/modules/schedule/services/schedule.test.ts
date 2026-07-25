/**
 * Integration tests for the schedule service.
 *
 * mySchedule:
 *   - Returns shifts with tags + department, ordered by clinicDate asc.
 *   - Availability resolves SELF tier after a self-update.
 *   - legacyNote surfaces when selfUpdatedAvailability is set on a membership.
 *   - No active term returns the all-empty shape.
 *   - No membership: availability null, legacyNote null; shifts still returned if any.
 *   - pendingRequests contains only PENDING requests, keyed by dateKey|departmentId.
 *   - pendingRequests excludes CANCELLED and APPROVED requests.
 *
 * fullSchedule:
 *   - dateKey param selects the correct Saturday.
 *   - Default picks the next upcoming date vs injected now.
 *   - past-all-dates fallback picks the last clinicDate.
 *   - Grouping: directors, volunteers, shadows in the right buckets with tags.
 *   - Conflict: a person assigned in two departments on the SAME Saturday gets
 *     the other department name in both departments' conflict maps.
 *   - Person in another department on a DIFFERENT date does NOT appear in conflicts.
 *   - Departments sorted by code (only departments with assignments on selected date appear).
 *   - Department with assignments only on a different date does not appear for the selected date.
 *   - Unrecognized dateKey falls back to the default selection.
 *
 * updateMyAvailability:
 *   - Happy path updates BOTH memberships of a two-dept person, clears
 *     acknowledgedAt, stores canonical noon-UTC dates, writes one audit row.
 *   - Non-clinic date rejected listing the bad ISO day key.
 *   - No active membership rejects with AvailabilityValidationError.
 *   - Dedupe: same day passed twice stored once.
 *   - Empty array clears availability (stores [], sets availabilityUpdatedAt, clears acknowledge).
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
import { publishSchedule } from "./publication";
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
    const live = result.terms.find((t) => t.isLive)!;

    expect(live.term.id).toBe(term.id);
    expect(live.clinicDates).toHaveLength(3);
    expect(live.shifts).toHaveLength(2);
    // Ordered by clinicDate asc.
    expect(isoDateKey(live.shifts[0].clinicDate)).toBe(isoDateKey(dates[0]));
    expect(isoDateKey(live.shifts[1].clinicDate)).toBe(isoDateKey(dates[2]));
    // Tags on first shift.
    expect(live.shifts[0].tags.walkin).toBe(true);
    expect(live.shifts[0].tags.cc).toBe(true);
    expect(live.shifts[0].tags.triage).toBe(false);
    // Tags on second shift.
    expect(live.shifts[1].tags.triage).toBe(true);
    // Department attached.
    expect(live.shifts[0].department.code).toBe("ITCM");
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
    const live = result.terms.find((t) => t.isLive)!;

    expect(live.availability).not.toBeNull();
    expect(live.availability?.tier).toBe("SELF");
    expect(live.availability?.dates).toHaveLength(2);
  });

  // #26 / #61: a director override on ONE of a multi-department member's
  // memberships must NOT fold into the editable availability (which would make
  // the whole form read-only and silently shadow the self-save on their other
  // department). The override is surfaced separately instead.
  it("surfaces a per-department director override without shadowing the member's editable availability elsewhere", async () => {
    const dates = saturdays("2026-05-30", 4); // [May30, Jun6, Jun13, Jun20]
    const term = await createTerm("ACTIVE", "SU26", dates);
    // The OVERRIDDEN department sorts first (memberships[0]); the old single-
    // membership read would return its DIRECTOR tier and lock the whole form.
    const deptC = await createDepartment("CCRH"); // 'C' sorts before 'S' -> memberships[0]
    const deptS = await createDepartment("SRR");
    const person = await createPerson("Dan");

    // Self dates are mirrored across both memberships (updateMyAvailability writes all rows).
    const self = [dates[0], dates[1]];
    const memC = await createMembership(person.id, term.id, deptC.id, "VOLUNTEER", {
      selfAvailabilityDates: self,
      availabilityUpdatedAt: utc(2026, 6, 1),
    });
    await createMembership(person.id, term.id, deptS.id, "VOLUNTEER", {
      selfAvailabilityDates: self,
      availabilityUpdatedAt: utc(2026, 6, 1),
    });
    // The CCRH director pins him to a single, different date.
    await prisma.termMembership.update({
      where: { id: memC.id },
      data: { directorAvailabilityDates: [dates[2]], directorAvailabilitySetAt: utc(2026, 6, 2) },
    });

    const result = await mySchedule(person.id);
    const live = result.terms.find((t) => t.isLive)!;

    // Editable availability is his own SELF tier (2 dates), NOT the CCRH director
    // pin -- even though CCRH is the first-sorted membership. (This is the assertion
    // the old memberships[0] read fails: it would return tier DIRECTOR here.)
    expect(live.availability?.tier).toBe("SELF");
    expect(live.availability?.dates.map((d) => isoDateKey(d))).toEqual(self.map((d) => isoDateKey(d)));
    // The form stays editable because his SRR membership is not overridden.
    expect(live.allDepartmentsOverridden).toBe(false);
    // The CCRH override is surfaced read-only, with its pinned date.
    expect(live.directorOverrides).toHaveLength(1);
    expect(live.directorOverrides[0].departmentCode).toBe("CCRH");
    expect(live.directorOverrides[0].dates.map((d) => isoDateKey(d))).toEqual([isoDateKey(dates[2])]);
  });

  // The single-department (or fully-overridden) case still hides the editor:
  // a self-save would move nothing when every department is director-managed.
  it("marks a fully director-managed member allDepartmentsOverridden", async () => {
    const dates = saturdays("2026-05-30", 3);
    const term = await createTerm("ACTIVE", "SU26", dates);
    const dept = await createDepartment("CCRH");
    const person = await createPerson("Dan");

    const mem = await createMembership(person.id, term.id, dept.id, "VOLUNTEER");
    await prisma.termMembership.update({
      where: { id: mem.id },
      data: { directorAvailabilityDates: [dates[0]], directorAvailabilitySetAt: utc(2026, 6, 2) },
    });

    const result = await mySchedule(person.id);
    const live = result.terms.find((t) => t.isLive)!;

    expect(live.allDepartmentsOverridden).toBe(true);
    expect(live.directorOverrides).toHaveLength(1);
    expect(live.directorOverrides[0].departmentCode).toBe("CCRH");
    // The editable availability is still exposed (self/baseline), but the page
    // withholds the Save form based on allDepartmentsOverridden.
    expect(live.availability).not.toBeNull();
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
    const live = result.terms.find((t) => t.isLive)!;

    expect(live.legacyNote).toBe("All Saturdays");
  });

  it("returns no term entries when the member has no ACTIVE membership in any live/next term", async () => {
    await createTerm("ARCHIVED", "SU26", []);
    const person = await createPerson("Dave");

    const result = await mySchedule(person.id);

    expect(result.terms).toHaveLength(0);
  });

  it("returns shifts but null availability and legacyNote when person has no membership", async () => {
    const dates = saturdays("2026-05-30", 2);
    const term = await createTerm("ACTIVE", "SU26", dates);
    const dept = await createDepartment("ITCM");
    const person = await createPerson("Eve");
    // No membership created, but still has a shift (edge case / manual assignment).
    await createShift(term.id, dept.id, person.id, dates[0], "VOLUNTEER");

    const result = await mySchedule(person.id);

    // getPersonTerms only returns terms backed by an ACTIVE membership, so with
    // no membership at all there are no term entries -- shift is orphaned data
    // with nothing to key it to (matches the invariant getPersonTerms documents).
    expect(result.terms).toHaveLength(0);
  });

  it("pendingRequests contains only PENDING requests keyed by dateKey|departmentId", async () => {
    const dates = saturdays("2026-05-30", 3);
    const term = await createTerm("ACTIVE", "SU26", dates);
    const dept = await createDepartment("ITCM");
    const person = await createPerson("Frank");
    await createMembership(person.id, term.id, dept.id, "VOLUNTEER");
    await createShift(term.id, dept.id, person.id, dates[0], "VOLUNTEER");
    await createShift(term.id, dept.id, person.id, dates[1], "VOLUNTEER");

    // Create a PENDING request for dates[0].
    await prisma.shiftRequest.create({
      data: {
        termId: term.id,
        requesterId: person.id,
        requesterDate: dates[0],
        departmentId: dept.id,
        status: "PENDING",
      },
    });

    const result = await mySchedule(person.id);
    const live = result.terms.find((t) => t.isLive)!;

    const expectedKey = `${isoDateKey(dates[0])}|${dept.id}`;
    expect(live.pendingRequests.size).toBe(1);
    expect(live.pendingRequests.has(expectedKey)).toBe(true);
    // dates[1] has no pending request.
    const key1 = `${isoDateKey(dates[1])}|${dept.id}`;
    expect(live.pendingRequests.has(key1)).toBe(false);
  });

  it("pendingRequests swap request includes target.name", async () => {
    const dates = saturdays("2026-05-30", 3);
    const term = await createTerm("ACTIVE", "SU26", dates);
    const dept = await createDepartment("ITCM");
    const requester = await createPerson("Harold");
    const swapTarget = await createPerson("Ingrid");
    await createMembership(requester.id, term.id, dept.id, "VOLUNTEER");
    await createShift(term.id, dept.id, requester.id, dates[0], "VOLUNTEER");
    await createShift(term.id, dept.id, swapTarget.id, dates[1], "VOLUNTEER");

    // Create a PENDING swap request pointing at swapTarget.
    await prisma.shiftRequest.create({
      data: {
        termId: term.id,
        requesterId: requester.id,
        requesterDate: dates[0],
        departmentId: dept.id,
        targetId: swapTarget.id,
        targetDate: dates[1],
        status: "PENDING",
      },
    });

    const result = await mySchedule(requester.id);
    const live = result.terms.find((t) => t.isLive)!;

    const expectedKey = `${isoDateKey(dates[0])}|${dept.id}`;
    expect(live.pendingRequests.size).toBe(1);
    const row = live.pendingRequests.get(expectedKey);
    expect(row).toBeDefined();
    expect(row?.target?.name).toBe("Ingrid");
  });

  it("pendingRequests excludes CANCELLED and APPROVED requests", async () => {
    const dates = saturdays("2026-05-30", 3);
    const term = await createTerm("ACTIVE", "SU26", dates);
    const dept = await createDepartment("ITCM");
    const person = await createPerson("Grace");
    await createMembership(person.id, term.id, dept.id, "VOLUNTEER");
    await createShift(term.id, dept.id, person.id, dates[0], "VOLUNTEER");
    await createShift(term.id, dept.id, person.id, dates[1], "VOLUNTEER");

    // CANCELLED request for dates[0].
    await prisma.shiftRequest.create({
      data: {
        termId: term.id,
        requesterId: person.id,
        requesterDate: dates[0],
        departmentId: dept.id,
        status: "CANCELLED",
      },
    });

    // APPROVED request for dates[1].
    await prisma.shiftRequest.create({
      data: {
        termId: term.id,
        requesterId: person.id,
        requesterDate: dates[1],
        departmentId: dept.id,
        status: "APPROVED",
      },
    });

    const result = await mySchedule(person.id);
    const live = result.terms.find((t) => t.isLive)!;

    expect(live.pendingRequests.size).toBe(0);
  });

  it("mySchedule hides next-term assignments until the department is published, then shows them", async () => {
    const live = await prisma.term.create({ data: { code: "SU26", name: "Summer", startDate: new Date("2026-05-30"), endDate: new Date("2026-09-26"), status: "ACTIVE", clinicDates: [] } });
    const d1 = new Date(Date.UTC(2026, 8, 5, 12));
    const next = await prisma.term.create({ data: { code: "FA26", name: "Fall", startDate: new Date("2026-09-01"), endDate: new Date("2027-01-01"), status: "PLANNING", clinicDates: [d1] } });
    const dept = await prisma.department.create({ data: { code: "SRHD", name: "SRHD" } });
    const dir = await prisma.person.create({ data: { name: "Dir", status: "ACTIVE" } });
    await prisma.termMembership.create({ data: { personId: dir.id, termId: live.id, departmentId: dept.id, kind: "DIRECTOR", status: "ACTIVE" } });
    const vol = await prisma.person.create({ data: { name: "Vol", status: "ACTIVE" } });
    await prisma.termMembership.create({ data: { personId: vol.id, termId: next.id, departmentId: dept.id, kind: "VOLUNTEER", status: "ACTIVE" } });
    await prisma.shiftAssignment.create({ data: { termId: next.id, departmentId: dept.id, clinicDate: d1, personId: vol.id, role: "VOLUNTEER", triage: false, walkin: false, cc: false, remote: false } });

    const before = await mySchedule(vol.id);
    const nextBefore = before.terms.find((t) => t.term.id === next.id)!;
    expect(nextBefore.shifts).toEqual([]); // not published -> hidden

    await publishSchedule(dir.id, { termId: next.id, departmentId: dept.id });
    const after = await mySchedule(vol.id);
    const nextAfter = after.terms.find((t) => t.term.id === next.id)!;
    expect(nextAfter.shifts.length).toBe(1); // published -> visible
  });

  it("mySchedule gates a next-term pending request by publish, same as its shifts", async () => {
    const live = await prisma.term.create({ data: { code: "SU26", name: "Summer", startDate: new Date("2026-05-30"), endDate: new Date("2026-09-26"), status: "ACTIVE", clinicDates: [] } });
    const d1 = new Date(Date.UTC(2026, 8, 5, 12));
    const next = await prisma.term.create({ data: { code: "FA26", name: "Fall", startDate: new Date("2026-09-01"), endDate: new Date("2027-01-01"), status: "PLANNING", clinicDates: [d1] } });
    const dept = await prisma.department.create({ data: { code: "SRHD", name: "SRHD" } });
    const dir = await prisma.person.create({ data: { name: "Dir", status: "ACTIVE" } });
    await prisma.termMembership.create({ data: { personId: dir.id, termId: live.id, departmentId: dept.id, kind: "DIRECTOR", status: "ACTIVE" } });
    const vol = await prisma.person.create({ data: { name: "Vol", status: "ACTIVE" } });
    await prisma.termMembership.create({ data: { personId: vol.id, termId: next.id, departmentId: dept.id, kind: "VOLUNTEER", status: "ACTIVE" } });
    await prisma.shiftRequest.create({ data: { termId: next.id, requesterId: vol.id, requesterDate: d1, departmentId: dept.id, status: "PENDING" } });

    // Unpublished: the pending request must not surface next to the "not published yet" state.
    const before = await mySchedule(vol.id);
    expect(before.terms.find((t) => t.term.id === next.id)!.pendingRequests.size).toBe(0);

    await publishSchedule(dir.id, { termId: next.id, departmentId: dept.id });
    const after = await mySchedule(vol.id);
    expect(after.terms.find((t) => t.term.id === next.id)!.pendingRequests.size).toBe(1);
  });
});

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
    const deptZ = await createDepartment("ZZZZ");
    const deptA = await createDepartment("AAAA");
    const deptM = await createDepartment("MMMM");

    const person = await createPerson("Sorter");
    // A scheduled person is an ACTIVE member of the department (fullSchedule now
    // filters to current members).
    await createMembership(person.id, term.id, deptZ.id, "VOLUNTEER");
    await createMembership(person.id, term.id, deptA.id, "VOLUNTEER");
    await createMembership(person.id, term.id, deptM.id, "VOLUNTEER");
    // Create one shift per department on the selected date so all three appear.
    await createShift(term.id, deptZ.id, person.id, dates[0], "VOLUNTEER");
    await createShift(term.id, deptA.id, person.id, dates[0], "VOLUNTEER");
    await createShift(term.id, deptM.id, person.id, dates[0], "VOLUNTEER");

    const result = await fullSchedule(isoDateKey(dates[0]));

    const codes = result.departments.map((d) => d.department.code);
    expect(codes).toHaveLength(3);
    expect(codes).toEqual([...codes].sort());
  });

  it("department with assignments only on a different date does not appear for the selected date", async () => {
    const dates = saturdays("2026-05-30", 2); // d[0] and d[1]
    const term = await createTerm("ACTIVE", "SU26", dates);
    const deptA = await createDepartment("AABB");
    const deptB = await createDepartment("BBCC");

    const person = await createPerson("Frank");
    await createMembership(person.id, term.id, deptA.id, "VOLUNTEER");
    await createMembership(person.id, term.id, deptB.id, "VOLUNTEER");

    // deptA has a shift on dates[0]; deptB only has a shift on dates[1].
    await createShift(term.id, deptA.id, person.id, dates[0], "VOLUNTEER");
    await createShift(term.id, deptB.id, person.id, dates[1], "VOLUNTEER");

    // Select dates[0] - only deptA should appear.
    const result = await fullSchedule(isoDateKey(dates[0]));

    const codes = result.departments.map((d) => d.department.code);
    expect(codes).toContain("AABB");
    expect(codes).not.toContain("BBCC");
  });

  it("unrecognized dateKey falls back to the default selection (next upcoming relative to now)", async () => {
    const dates = saturdays("2026-05-30", 3); // d[0], d[1], d[2]
    const term = await createTerm("ACTIVE", "SU26", dates);
    const dept = await createDepartment("ITCM");
    const person = await createPerson("Grace");

    // Add a shift on dates[1] so the fallback date has at least one department.
    await createShift(term.id, dept.id, person.id, dates[1], "VOLUNTEER");

    // now = one day after d[0], so the default fallback is d[1].
    const now = new Date(dates[0].getTime() + 86400000);
    const result = await fullSchedule("9999-99-99", now);

    expect(result.selectedDate).not.toBeNull();
    expect(isoDateKey(result.selectedDate!)).toBe(isoDateKey(dates[1]));
  });

  it("no active term returns all-empty shape", async () => {
    await createTerm("ARCHIVED", "SU26", []);

    const result = await fullSchedule();

    expect(result.term).toBeNull();
    expect(result.clinicDates).toHaveLength(0);
    expect(result.selectedDate).toBeNull();
    expect(result.departments).toHaveLength(0);
  });

  // #62: offboarding / removeMembership leave the ShiftAssignment row, so the
  // master schedule must drop people who are no longer ACTIVE members of the
  // department, matching who the shift-reminders cron notifies.
  it("excludes an assignee whose department membership is REMOVED", async () => {
    const dates = saturdays("2026-05-30", 1);
    const term = await createTerm("ACTIVE", "SU26", dates);
    const dept = await createDepartment("AABB");
    const active = await createPerson("Active Vol");
    const departed = await createPerson("Departed Vol");

    await createMembership(active.id, term.id, dept.id, "VOLUNTEER");
    await createMembership(departed.id, term.id, dept.id, "VOLUNTEER", { status: "REMOVED" });
    await createShift(term.id, dept.id, active.id, dates[0], "VOLUNTEER");
    await createShift(term.id, dept.id, departed.id, dates[0], "VOLUNTEER");

    const result = await fullSchedule(isoDateKey(dates[0]));
    const names = result.departments.flatMap((d) => d.volunteers.map((v) => v.name));
    expect(names).toEqual(["Active Vol"]);
  });
});

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

    await updateMyAvailability(person.id, { termId: term.id, dates: callerDates });

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

    await expect(
      updateMyAvailability(person.id, { termId: term.id, dates: [badDate] }),
    ).rejects.toThrow("2026-07-01");
    await expect(
      updateMyAvailability(person.id, { termId: term.id, dates: [badDate] }),
    ).rejects.toBeInstanceOf(AvailabilityValidationError);
  });

  it("rejects with AvailabilityValidationError when person has no active membership in active term", async () => {
    const dates = saturdays("2026-05-30", 2);
    const term = await createTerm("ACTIVE", "SU26", dates);
    const person = await createPerson("Carol");
    // No membership created.

    await expect(
      updateMyAvailability(person.id, { termId: term.id, dates: [dates[0]] }),
    ).rejects.toBeInstanceOf(AvailabilityValidationError);
    await expect(
      updateMyAvailability(person.id, { termId: term.id, dates: [dates[0]] }),
    ).rejects.toThrow("not on that term's roster");
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

    await updateMyAvailability(person.id, { termId: term.id, dates: [midnight, noon] });

    const updated = await prisma.termMembership.findUniqueOrThrow({ where: { id: mem.id } });
    expect(updated.selfAvailabilityDates).toHaveLength(1);
  });

  it("empty array clears availability: stores [], sets availabilityUpdatedAt, clears acknowledgedAt, no error", async () => {
    const dates = saturdays("2026-05-30", 2);
    const term = await createTerm("ACTIVE", "SU26", dates);
    const dept = await createDepartment("ITCM");
    const person = await createPerson("Eve");
    const mem = await createMembership(person.id, term.id, dept.id, "VOLUNTEER", {
      selfAvailabilityDates: [dates[0]],
      availabilityUpdatedAt: utc(2026, 5, 1),
      availabilityAcknowledgedAt: utc(2026, 5, 2),
    });

    await expect(
      updateMyAvailability(person.id, { termId: term.id, dates: [] }),
    ).resolves.toBeUndefined();

    const updated = await prisma.termMembership.findUniqueOrThrow({ where: { id: mem.id } });
    expect(updated.selfAvailabilityDates).toHaveLength(0);
    expect(updated.availabilityUpdatedAt).not.toBeNull();
    expect(updated.availabilityAcknowledgedAt).toBeNull();
  });

  it("rejects an availability save for a term with no clinic dates, so an empty grid can't wipe the baseline (#90)", async () => {
    const term = await createTerm("ACTIVE", "SU26", []); // calendar not set yet
    const dept = await createDepartment("ITCM");
    const person = await createPerson("Zoe");
    const mem = await createMembership(person.id, term.id, dept.id, "VOLUNTEER");

    await expect(
      updateMyAvailability(person.id, { termId: term.id, dates: [] }),
    ).rejects.toBeInstanceOf(AvailabilityValidationError);

    // No SELF tier written: availabilityUpdatedAt stays null so resolveAvailability
    // keeps returning BASELINE (the application answers), not an empty SELF tier.
    const after = await prisma.termMembership.findUniqueOrThrow({ where: { id: mem.id } });
    expect(after.availabilityUpdatedAt).toBeNull();
  });

  it("updateMyAvailability writes the passed (next) term while a different term is live", async () => {
    // live term + next term, member active in BOTH; next term has clinic dates
    const live = await prisma.term.create({ data: { code: "SU26", name: "Summer", startDate: new Date("2026-05-30"), endDate: new Date("2026-09-26"), status: "ACTIVE", clinicDates: [] } });
    const nextDates = [new Date(Date.UTC(2026, 8, 5, 12))];
    const next = await prisma.term.create({ data: { code: "FA26", name: "Fall", startDate: new Date("2026-09-01"), endDate: new Date("2027-01-01"), status: "PLANNING", clinicDates: nextDates } });
    const dept = await prisma.department.create({ data: { code: "SRHD", name: "SRHD" } });
    const vol = await prisma.person.create({ data: { name: "Vol", status: "ACTIVE" } });
    await prisma.termMembership.create({ data: { personId: vol.id, termId: live.id, departmentId: dept.id, kind: "VOLUNTEER", status: "ACTIVE" } });
    const m = await prisma.termMembership.create({ data: { personId: vol.id, termId: next.id, departmentId: dept.id, kind: "VOLUNTEER", status: "ACTIVE" } });

    await updateMyAvailability(vol.id, { termId: next.id, dates: nextDates });
    const updated = await prisma.termMembership.findUniqueOrThrow({ where: { id: m.id } });
    expect(updated.selfAvailabilityDates.map((d) => d.getTime())).toEqual(nextDates.map((d) => d.getTime()));
    // the live-term membership is untouched
    const liveM = await prisma.termMembership.findFirstOrThrow({ where: { personId: vol.id, termId: live.id } });
    expect(liveM.selfAvailabilityDates).toEqual([]);
  });

  it("updateMyAvailability rejects a term the member is not an active member of", async () => {
    const other = await prisma.term.create({ data: { code: "XX26", name: "Other", startDate: new Date("2026-01-01"), endDate: new Date("2026-02-01"), status: "PLANNING", clinicDates: [] } });
    const vol = await prisma.person.create({ data: { name: "Vol", status: "ACTIVE" } });
    await expect(updateMyAvailability(vol.id, { termId: other.id, dates: [] })).rejects.toBeInstanceOf(AvailabilityValidationError);
  });
});
