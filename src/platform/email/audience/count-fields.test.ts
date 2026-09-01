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

  it("matches nobody when there is no active term", async () => {
    await prisma.person.create({
      data: { name: "Orphan", contactEmail: "orphan@x.com", status: "ACTIVE" },
    });
    const { recipients } = await resolveAudience(audienceFor("shiftCountThisTerm", "gte", "0"));
    expect(recipients).toEqual([]);
  });
});
