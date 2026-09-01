/**
 * Tests for the people directory's counting and filtering.
 *
 * The thing most worth pinning down is seats vs people: a TermMembership row is
 * a seat, and someone who directs one department and volunteers in another holds
 * two. `directorySummary` counts distinct PEOPLE, `departmentBreakdown` counts
 * SEATS, and the two are deliberately allowed to disagree. Every test below that
 * involves the dual-role member exists to keep that difference from being
 * "corrected" into a single wrong number.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import {
  directorySummary,
  departmentBreakdown,
  directoryPeople,
  directoryAttendings,
} from "./directory";

async function createTerm(status: "ACTIVE" | "PLANNING" = "ACTIVE", code = "FA26") {
  return prisma.term.create({
    data: {
      code,
      name: `Term ${code}`,
      startDate: new Date("2026-08-01"),
      endDate: new Date("2026-12-20"),
      status,
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

async function seat(
  personId: string,
  termId: string,
  departmentId: string,
  kind: "DIRECTOR" | "VOLUNTEER",
  status: "ACTIVE" | "REMOVED" = "ACTIVE",
) {
  return prisma.termMembership.create({
    data: { personId, termId, departmentId, kind, status },
  });
}

/**
 * One director, one volunteer, and one person who is BOTH -- a director in NURS
 * and a volunteer in TRIA. Three people, four seats. Every count assertion in
 * this file is read against that shape.
 */
async function seedRoster() {
  const term = await createTerm();
  const nurs = await createDepartment("NURS");
  const tria = await createDepartment("TRIA");

  const director = await prisma.person.create({
    data: { name: "Dana Director", netId: "dd111", contactEmail: "dana@example.com", phone: "203-555-0100" },
  });
  const volunteer = await prisma.person.create({
    data: { name: "Vic Volunteer", contactEmail: "vic@example.com" },
  });
  const both = await prisma.person.create({
    data: { name: "Bo Both", netId: "bb333" },
  });

  await seat(director.id, term.id, nurs.id, "DIRECTOR");
  await seat(volunteer.id, term.id, tria.id, "VOLUNTEER");
  await seat(both.id, term.id, nurs.id, "DIRECTOR");
  await seat(both.id, term.id, tria.id, "VOLUNTEER");

  return { term, nurs, tria, director, volunteer, both };
}

beforeEach(resetDb);

describe("directorySummary", () => {
  it("counts distinct people, so a dual-role member is in both role counts", async () => {
    const { term } = await seedRoster();

    const summary = await directorySummary(term.id);

    expect(summary.activePeople).toBe(3);
    // 2 + 2 = 4 > 3 activePeople, and that is correct, not double counting:
    // Bo genuinely is both a director and a volunteer.
    expect(summary.directors).toBe(2);
    expect(summary.volunteers).toBe(2);
    expect(summary.bothRoles).toBe(1);
    expect(summary.departmentsStaffed).toBe(2);
  });

  it("excludes REMOVED seats and OFFBOARDED people", async () => {
    const { term, nurs, tria } = await seedRoster();
    // A seat someone has left.
    const departed = await prisma.person.create({ data: { name: "Rem Removed" } });
    await seat(departed.id, term.id, nurs.id, "VOLUNTEER", "REMOVED");
    // A person who has left the clinic but whose seat was never flipped. Both
    // halves have to be checked -- offboarding is convergent but the two states
    // can be out of step mid-process.
    const gone = await prisma.person.create({
      data: { name: "Off Boarded", status: "OFFBOARDED" },
    });
    await seat(gone.id, term.id, tria.id, "VOLUNTEER");

    const summary = await directorySummary(term.id);

    expect(summary.activePeople).toBe(3);
    expect(summary.volunteers).toBe(2);
  });

  it("ignores seats from another term", async () => {
    const { term } = await seedRoster();
    const old = await createTerm("PLANNING", "SP26");
    const oldDept = await createDepartment("HIST");
    const alum = await prisma.person.create({ data: { name: "Al Alum" } });
    await seat(alum.id, old.id, oldDept.id, "VOLUNTEER");

    const summary = await directorySummary(term.id);

    expect(summary.activePeople).toBe(3);
    expect(summary.departmentsStaffed).toBe(2);
  });

  it("still counts attendings when no term is active", async () => {
    // Attendings are faculty: they cover clinic whether or not a term is open,
    // so a null termId must not zero them out along with the roster.
    await prisma.attending.create({
      data: { scheduleName: "Dr. A", fullName: "Dr. Alice Attending", isActive: true },
    });
    await prisma.attending.create({
      data: { scheduleName: "Dr. B", fullName: "Dr. Bob Retired", isActive: false },
    });

    const summary = await directorySummary(null);

    expect(summary.activePeople).toBe(0);
    expect(summary.attendings).toBe(1);
  });
});

describe("departmentBreakdown", () => {
  it("counts seats per department, so the totals exceed the headcount", async () => {
    const { term } = await seedRoster();

    const rows = await departmentBreakdown(term.id);
    const nurs = rows.find((r) => r.code === "NURS")!;
    const tria = rows.find((r) => r.code === "TRIA")!;

    expect(nurs).toMatchObject({ directors: 2, volunteers: 0, total: 2 });
    expect(tria).toMatchObject({ directors: 0, volunteers: 2, total: 2 });
    // 4 seats across 3 people: the gap the page explains rather than hides.
    expect(rows.reduce((s, r) => s + r.total, 0)).toBe(4);
  });

  it("keeps an empty department at zero rather than dropping the row", async () => {
    const { term } = await seedRoster();
    await createDepartment("EMPTY");

    const rows = await departmentBreakdown(term.id);

    // An unstaffed department is exactly the thing an ED wants to notice.
    expect(rows.find((r) => r.code === "EMPTY")).toMatchObject({ total: 0 });
  });
});

describe("directoryPeople", () => {
  it("filters by department and shows only that department's seats", async () => {
    const { term, nurs } = await seedRoster();

    const { rows, total } = await directoryPeople(term.id, { departmentId: nurs.id }, 1, 50);

    expect(total).toBe(2);
    expect(rows.map((r) => r.name)).toEqual(["Bo Both", "Dana Director"]);
    // The nested seat filter matters as much as the outer one: without it Bo's
    // TRIA seat would show up under a NURS filter.
    expect(rows.find((r) => r.name === "Bo Both")!.seats).toEqual([
      { departmentCode: "NURS", kind: "DIRECTOR" },
    ]);
  });

  it("filters by role", async () => {
    const { term } = await seedRoster();

    const { rows } = await directoryPeople(term.id, { kind: "DIRECTOR" }, 1, 50);

    expect(rows.map((r) => r.name)).toEqual(["Bo Both", "Dana Director"]);
  });

  it("searches name, NetID, and contact email", async () => {
    const { term } = await seedRoster();

    expect((await directoryPeople(term.id, { q: "dana" }, 1, 50)).rows).toHaveLength(1);
    expect((await directoryPeople(term.id, { q: "bb333" }, 1, 50)).rows).toHaveLength(1);
    expect((await directoryPeople(term.id, { q: "vic@example" }, 1, 50)).rows).toHaveLength(1);
  });

  it("returns an empty page rather than throwing when no term is active", async () => {
    const result = await directoryPeople(null, {}, 1, 50);

    expect(result).toMatchObject({ rows: [], total: 0, pageCount: 1 });
  });

  it("paginates", async () => {
    const { term } = await seedRoster();

    const first = await directoryPeople(term.id, {}, 1, 2);
    const second = await directoryPeople(term.id, {}, 2, 2);

    expect(first.rows.map((r) => r.name)).toEqual(["Bo Both", "Dana Director"]);
    expect(second.rows.map((r) => r.name)).toEqual(["Vic Volunteer"]);
    expect(first.pageCount).toBe(2);
  });
});

describe("directoryAttendings", () => {
  it("lists active attendings with their specialty, and drops inactive ones", async () => {
    const specialty = await prisma.attendingSpecialty.create({
      data: { code: "RHD", name: "Reproductive Health", order: 1 },
    });
    await prisma.attending.create({
      data: {
        scheduleName: "Dr. Chen",
        fullName: "Dr. Casey Chen",
        credentials: "MD",
        specialtyId: specialty.id,
        email: "casey@example.com",
        isActive: true,
      },
    });
    await prisma.attending.create({
      data: { scheduleName: "Dr. Gone", fullName: "Dr. Gone Away", isActive: false },
    });

    const rows = await directoryAttendings();

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      fullName: "Dr. Casey Chen",
      credentials: "MD",
      specialty: "Reproductive Health",
      email: "casey@example.com",
    });
  });
});
