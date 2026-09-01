import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { resolveAudience } from "./resolve";
import type { Audience } from "./types";

beforeEach(resetDb);

function audienceFor(field: string, op: string, value: string | string[]): Audience {
  return { recordType: "PERSON", match: "ALL", conditions: [{ field, op: op as never, value }] };
}

/**
 * An active term, a department, and three people with two, one, and zero
 * shifts. Read prisma/schema.prisma for the required Term / Department /
 * ShiftAssignment fields before writing; the shapes below are expected, and the
 * schema is authoritative.
 */
async function rosterWithShifts() {
  const term = await prisma.term.create({
    data: {
      code: "SP26", name: "Spring 2026", status: "ACTIVE",
      startDate: new Date("2026-01-01"), endDate: new Date("2026-06-01"),
    },
  });
  const dept = await prisma.department.create({ data: { code: "TST", name: "Test" } });

  const make = async (name: string, email: string, shifts: number) => {
    const p = await prisma.person.create({
      data: { name, contactEmail: email, status: "ACTIVE" },
    });
    await prisma.termMembership.create({
      data: { personId: p.id, termId: term.id, departmentId: dept.id, kind: "VOLUNTEER", status: "ACTIVE" },
    });
    for (let i = 0; i < shifts; i++) {
      await prisma.shiftAssignment.create({
        data: {
          termId: term.id, departmentId: dept.id, personId: p.id,
          clinicDate: new Date(Date.UTC(2026, 2, 7 + i, 12, 0, 0)),
          role: "VOLUNTEER",
        },
      });
    }
    return p;
  };

  await make("Two", "two@x.com", 2);
  await make("One", "one@x.com", 1);
  await make("Zero", "zero@x.com", 0);
  return term;
}

describe("schedule count fields", () => {
  it("counts assigned shifts", async () => {
    await rosterWithShifts();
    const { recipients } = await resolveAudience(audienceFor("shiftCountThisTerm", "gte", "2"));
    expect(recipients.map((r) => r.email)).toEqual(["two@x.com"]);
  });

  // The regression this task exists to prevent.
  it("includes people with ZERO shifts under a `less than` comparison", async () => {
    await rosterWithShifts();
    const { recipients } = await resolveAudience(audienceFor("shiftCountThisTerm", "lt", "1"));
    expect(recipients.map((r) => r.email)).toEqual(["zero@x.com"]);
  });

  it("treats a between range inclusively", async () => {
    await rosterWithShifts();
    const { recipients } = await resolveAudience(
      audienceFor("shiftCountThisTerm", "between", ["1", "2"]),
    );
    expect(recipients.map((r) => r.email).sort()).toEqual(["one@x.com", "two@x.com"]);
  });

  // "two" is assigned Mar 7 and Mar 8 and attends only Mar 7, so is a
  // no-show for Mar 8. "one" is assigned Mar 7 (from rosterWithShifts) and
  // has NO attendance row at all, so is ALSO a no-show, even though someone
  // else (two) has a ClinicAttendance row on that same calendar date.
  // Asserting both, rather than just two@x.com, is deliberate: attendance is
  // per-person (ClinicAttendance is unique on termId+clinicDate+personId), so
  // a same-date row for a different person must never suppress this one. An
  // implementation that compared by date alone, ignoring personId, would
  // wrongly drop one@x.com here.
  it("counts no-shows as assigned dates with no attendance row", async () => {
    const term = await rosterWithShifts();
    const two = await prisma.person.findFirstOrThrow({ where: { contactEmail: "two@x.com" } });
    await prisma.clinicAttendance.create({
      data: {
        termId: term.id, personId: two.id,
        clinicDate: new Date(Date.UTC(2026, 2, 7, 12, 0, 0)),
        method: "STAFF",
      },
    });

    const { recipients } = await resolveAudience(audienceFor("noShowCountThisTerm", "gte", "1"));
    expect(recipients.map((r) => r.email).sort()).toEqual(["one@x.com", "two@x.com"]);
  });

  // ShiftAssignment is unique on (termId, departmentId, clinicDate, personId),
  // not (termId, clinicDate, personId): one person can legitimately hold two
  // assignment rows on the same clinicDate, one per department. A no-show is
  // scored per DAY, matching how attendance itself works (ClinicAttendance IS
  // unique on termId+clinicDate+personId), so this must count once, not once
  // per assignment row.
  it("counts a same-day, two-department assignment as one no-show, not two", async () => {
    const term = await prisma.term.create({
      data: {
        code: "FA26", name: "Fall 2026", status: "ACTIVE",
        startDate: new Date("2026-08-01"), endDate: new Date("2026-12-01"),
      },
    });
    const deptA = await prisma.department.create({ data: { code: "DA", name: "Dept A" } });
    const deptB = await prisma.department.create({ data: { code: "DB", name: "Dept B" } });
    const person = await prisma.person.create({
      data: { name: "Double", contactEmail: "double@x.com", status: "ACTIVE" },
    });
    await prisma.termMembership.create({
      data: { personId: person.id, termId: term.id, departmentId: deptA.id, kind: "VOLUNTEER", status: "ACTIVE" },
    });
    const clinicDate = new Date(Date.UTC(2026, 8, 10, 12, 0, 0));
    await prisma.shiftAssignment.create({
      data: { termId: term.id, departmentId: deptA.id, personId: person.id, clinicDate, role: "VOLUNTEER" },
    });
    await prisma.shiftAssignment.create({
      data: { termId: term.id, departmentId: deptB.id, personId: person.id, clinicDate, role: "VOLUNTEER" },
    });
    // No ClinicAttendance row at all: a full no-show for that one day.

    const { recipients: eqOne } = await resolveAudience(audienceFor("noShowCountThisTerm", "eq", "1"));
    expect(eqOne.map((r) => r.email)).toEqual(["double@x.com"]);

    const { recipients: eqTwo } = await resolveAudience(audienceFor("noShowCountThisTerm", "eq", "2"));
    expect(eqTwo.map((r) => r.email)).toEqual([]);
  });

  it("matches nobody when there is no active term", async () => {
    await prisma.person.create({
      data: { name: "Orphan", contactEmail: "orphan@x.com", status: "ACTIVE" },
    });
    const { recipients } = await resolveAudience(audienceFor("shiftCountThisTerm", "gte", "0"));
    expect(recipients).toEqual([]);
  });
});

describe("upcomingShiftCount (clinic zone, not UTC)", () => {
  // The display zone defaults to America/New_York (no Setting row after
  // resetDb). 9:30pm Eastern on 2026-07-15 is 2026-07-16T01:30:00Z: UTC has
  // already rolled over to the 16th, but it is still "today" (the 15th) in
  // Eastern. A shift scheduled for noon UTC on the 15th (8am Eastern that same
  // day) must still count as upcoming. A UTC-calendar-day cutoff, or one that
  // ignores the injected `now` and reads the real wall clock instead, gets
  // this wrong for hours every evening -- exactly when someone would check.
  it("treats a shift as upcoming using the clinic's zone, not the UTC calendar day", async () => {
    const term = await prisma.term.create({
      data: {
        code: "SU26B", name: "Summer 2026 B", status: "ACTIVE",
        startDate: new Date("2026-06-01"), endDate: new Date("2026-08-01"),
      },
    });
    const dept = await prisma.department.create({ data: { code: "EVE", name: "Evening Test" } });
    const person = await prisma.person.create({
      data: { name: "Evening", contactEmail: "evening@x.com", status: "ACTIVE" },
    });
    await prisma.termMembership.create({
      data: { personId: person.id, termId: term.id, departmentId: dept.id, kind: "VOLUNTEER", status: "ACTIVE" },
    });
    await prisma.shiftAssignment.create({
      data: {
        termId: term.id, departmentId: dept.id, personId: person.id,
        clinicDate: new Date(Date.UTC(2026, 6, 15, 12, 0, 0)),
        role: "VOLUNTEER",
      },
    });

    const now = new Date("2026-07-16T01:30:00.000Z"); // 9:30pm Eastern, July 15
    const { recipients } = await resolveAudience(
      audienceFor("upcomingShiftCount", "gte", "1"),
      { now },
    );
    expect(recipients.map((r) => r.email)).toEqual(["evening@x.com"]);
  });
});

describe("attendanceCountThisTerm", () => {
  async function rosterWithAttendance() {
    const term = await prisma.term.create({
      data: {
        code: "SU26C", name: "Summer 2026 C", status: "ACTIVE",
        startDate: new Date("2026-06-01"), endDate: new Date("2026-08-01"),
      },
    });
    const dept = await prisma.department.create({ data: { code: "ATT", name: "Attendance Test" } });

    const make = async (name: string, email: string, days: number) => {
      const p = await prisma.person.create({
        data: { name, contactEmail: email, status: "ACTIVE" },
      });
      await prisma.termMembership.create({
        data: { personId: p.id, termId: term.id, departmentId: dept.id, kind: "VOLUNTEER", status: "ACTIVE" },
      });
      for (let i = 0; i < days; i++) {
        await prisma.clinicAttendance.create({
          data: {
            termId: term.id, personId: p.id,
            clinicDate: new Date(Date.UTC(2026, 6, 7 + i, 12, 0, 0)),
            method: "STAFF",
          },
        });
      }
      return p;
    };

    await make("TwoDays", "twodays@x.com", 2);
    await make("NoDays", "nodays@x.com", 0);
  }

  it("includes people with ZERO attendance under a `less than` comparison", async () => {
    await rosterWithAttendance();
    const { recipients } = await resolveAudience(audienceFor("attendanceCountThisTerm", "lt", "1"));
    expect(recipients.map((r) => r.email)).toEqual(["nodays@x.com"]);
  });

  it("matches nobody when there is no active term", async () => {
    await prisma.person.create({
      data: { name: "Orphan2", contactEmail: "orphan2@x.com", status: "ACTIVE" },
    });
    const { recipients } = await resolveAudience(audienceFor("attendanceCountThisTerm", "gte", "0"));
    expect(recipients).toEqual([]);
  });
});
