/**
 * Tests for the people directory's counting and filtering.
 *
 * The thing most worth pinning down is seats vs people: a TermMembership row is
 * a seat, and someone who directs one department and volunteers in another holds
 * two. `directorySummary` counts distinct PEOPLE, `departmentBreakdown` counts
 * SEATS, and the two are deliberately allowed to disagree. Every test below that
 * involves the dual-role member exists to keep that difference from being
 * "corrected" into a single wrong number.
 *
 * The second thing is scope. The same functions serve an Executive Director
 * (clinic-wide) and a department director (their departments), and the whole
 * point of threading a DirectoryScope through every query is that the counts,
 * the roster, the address list and the CSV cannot disagree about who is in it.
 * The "scoped" block at the bottom is where that is pinned down.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import {
  directorySummary,
  departmentBreakdown,
  directoryPeople,
  directoryEmails,
  directoryAttendings,
  directoryScopeFor,
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

    const summary = await directorySummary(term.id, null);

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

    const summary = await directorySummary(term.id, null);

    expect(summary.activePeople).toBe(3);
    expect(summary.volunteers).toBe(2);
  });

  it("ignores seats from another term", async () => {
    const { term } = await seedRoster();
    const old = await createTerm("PLANNING", "SP26");
    const oldDept = await createDepartment("HIST");
    const alum = await prisma.person.create({ data: { name: "Al Alum" } });
    await seat(alum.id, old.id, oldDept.id, "VOLUNTEER");

    const summary = await directorySummary(term.id, null);

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

    const summary = await directorySummary(null, null);

    expect(summary.activePeople).toBe(0);
    expect(summary.attendings).toBe(1);
  });
});

describe("departmentBreakdown", () => {
  it("counts seats per department, so the totals exceed the headcount", async () => {
    const { term } = await seedRoster();

    const rows = await departmentBreakdown(term.id, null);
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

    const rows = await departmentBreakdown(term.id, null);

    // An unstaffed department is exactly the thing an ED wants to notice.
    expect(rows.find((r) => r.code === "EMPTY")).toMatchObject({ total: 0 });
  });
});

describe("directoryPeople", () => {
  it("filters by department, splitting matched seats from the person's others", async () => {
    const { term, nurs } = await seedRoster();

    const { rows, total } = await directoryPeople(term.id, { departmentId: nurs.id }, null, 1, 50);

    expect(total).toBe(2);
    expect(rows.map((r) => r.name)).toEqual(["Bo Both", "Dana Director"]);
    const bo = rows.find((r) => r.name === "Bo Both")!;
    expect(bo.seats).toEqual([{ departmentCode: "NURS", kind: "DIRECTOR" }]);
    // The whole point of the split: under a NURS filter Bo must still be
    // visibly a two-department member, or the roster makes him look like Dana.
    expect(bo.otherSeats).toEqual([{ departmentCode: "TRIA", kind: "VOLUNTEER" }]);
    expect(rows.find((r) => r.name === "Dana Director")!.otherSeats).toEqual([]);
  });

  it("leaves otherSeats empty when nothing is filtered out", async () => {
    const { term } = await seedRoster();

    const { rows } = await directoryPeople(term.id, {}, null, 1, 50);

    const bo = rows.find((r) => r.name === "Bo Both")!;
    expect(bo.seats).toEqual([
      { departmentCode: "NURS", kind: "DIRECTOR" },
      { departmentCode: "TRIA", kind: "VOLUNTEER" },
    ]);
    expect(rows.every((r) => r.otherSeats.length === 0)).toBe(true);
  });

  it("filters by role, keeping the seats held in the other role as context", async () => {
    const { term } = await seedRoster();

    const { rows } = await directoryPeople(term.id, { kind: "DIRECTOR" }, null, 1, 50);

    expect(rows.map((r) => r.name)).toEqual(["Bo Both", "Dana Director"]);
    const bo = rows.find((r) => r.name === "Bo Both")!;
    expect(bo.seats).toEqual([{ departmentCode: "NURS", kind: "DIRECTOR" }]);
    expect(bo.otherSeats).toEqual([{ departmentCode: "TRIA", kind: "VOLUNTEER" }]);
  });

  it("never surfaces a REMOVED seat as one of the person's other seats", async () => {
    const { term, nurs, both } = await seedRoster();
    // A seat Bo has left, and one from a term that is over. Neither is "outside
    // the filter" -- both are off the roster -- so neither may show up as an
    // "also" line the way the live TRIA seat does.
    const educ = await createDepartment("EDUC");
    await seat(both.id, term.id, educ.id, "VOLUNTEER", "REMOVED");
    const old = await createTerm("PLANNING", "SP25");
    await seat(both.id, old.id, educ.id, "VOLUNTEER");

    const { rows } = await directoryPeople(term.id, { departmentId: nurs.id }, null, 1, 50);

    expect(rows.find((r) => r.name === "Bo Both")!.otherSeats).toEqual([
      { departmentCode: "TRIA", kind: "VOLUNTEER" },
    ]);
  });

  it("searches name, NetID, and contact email", async () => {
    const { term } = await seedRoster();

    expect((await directoryPeople(term.id, { q: "dana" }, null, 1, 50)).rows).toHaveLength(1);
    expect((await directoryPeople(term.id, { q: "bb333" }, null, 1, 50)).rows).toHaveLength(1);
    expect((await directoryPeople(term.id, { q: "vic@example" }, null, 1, 50)).rows).toHaveLength(1);
  });

  it("returns an empty page rather than throwing when no term is active", async () => {
    const result = await directoryPeople(null, {}, null, 1, 50);

    expect(result).toMatchObject({ rows: [], total: 0, pageCount: 1 });
  });

  it("paginates", async () => {
    const { term } = await seedRoster();

    const first = await directoryPeople(term.id, {}, null, 1, 2);
    const second = await directoryPeople(term.id, {}, null, 2, 2);

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

    const rows = await directoryAttendings(null);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      fullName: "Dr. Casey Chen",
      credentials: "MD",
      specialty: "Reproductive Health",
      email: "casey@example.com",
    });
  });
});

// ---------------------------------------------------------------------------
// Scope
// ---------------------------------------------------------------------------

/** A role granting exactly `permission`, targeted at DIRECTOR memberships --
 *  the shape the real Director baseline is provisioned with. */
async function grantToDirectorKind(permission: string, name = `Role ${permission}`) {
  const role = await prisma.role.create({
    data: { name, grants: { create: [{ permission }] } },
  });
  await prisma.roleAssignment.create({ data: { roleId: role.id, kind: "DIRECTOR", termId: null } });
  return role;
}

describe("directoryScopeFor", () => {
  it("returns null (the whole clinic) for a holder of the unscoped permission", async () => {
    const { director } = await seedRoster();
    const role = await prisma.role.create({
      data: {
        name: "Executive Director",
        grants: { create: [{ permission: "volunteers.view_directory" }] },
      },
    });
    await prisma.roleAssignment.create({
      data: { roleId: role.id, personId: director.id, termId: null },
    });

    expect(await directoryScopeFor(director.id)).toBeNull();
  });

  it("resolves the scoped permission to the departments the person DIRECTS", async () => {
    const { nurs, both } = await seedRoster();
    await grantToDirectorKind("volunteers.view_directory_own_dept");

    // Bo directs NURS and volunteers in TRIA. A kind-targeted grant reaches the
    // directorship only, which is the whole reason this is not can().
    expect(await directoryScopeFor(both.id)).toEqual({ departmentIds: [nurs.id] });
  });
});

describe("scoped reads", () => {
  /** Bo directs NURS; the scope that grant resolves to. */
  async function scopedToNurs() {
    const roster = await seedRoster();
    await grantToDirectorKind("volunteers.view_directory_own_dept");
    const scope = await directoryScopeFor(roster.both.id);
    return { ...roster, scope };
  }

  it("counts only the people seated in the viewer's departments", async () => {
    const { term, scope } = await scopedToNurs();

    const summary = await directorySummary(term.id, scope);

    // Dana and Bo hold NURS seats; Vic is TRIA-only and is not this director's
    // to see. Bo's TRIA volunteering does not make him a volunteer here either.
    expect(summary.activePeople).toBe(2);
    expect(summary.directors).toBe(2);
    expect(summary.volunteers).toBe(0);
    expect(summary.departmentsStaffed).toBe(1);
  });

  it("lists only the viewer's departments in the breakdown", async () => {
    const { term, scope } = await scopedToNurs();
    await createDepartment("EMPTY");

    const rows = await departmentBreakdown(term.id, scope);

    expect(rows.map((r) => r.code)).toEqual(["NURS"]);
  });

  it("hides an out-of-scope person from the roster", async () => {
    const { term, scope } = await scopedToNurs();

    const { rows, total } = await directoryPeople(term.id, {}, scope, 1, 50);

    expect(total).toBe(2);
    expect(rows.map((r) => r.name)).toEqual(["Bo Both", "Dana Director"]);
  });

  it("does not name an out-of-scope department as one of a person's other seats", async () => {
    const { term, scope } = await scopedToNurs();

    const { rows } = await directoryPeople(term.id, {}, scope, 1, 50);

    // Unscoped, Bo's TRIA seat shows as context. Scoped, the viewer's boundary
    // is not a filter they chose, so TRIA does not appear at all.
    const bo = rows.find((r) => r.name === "Bo Both")!;
    expect(bo.seats).toEqual([{ departmentCode: "NURS", kind: "DIRECTOR" }]);
    expect(bo.otherSeats).toEqual([]);
  });

  it("selects nobody when the requested department is outside the scope", async () => {
    const { term, tria, scope } = await scopedToNurs();

    // The failure this guards is the opposite outcome: written as a spread onto
    // one object literal, the requested department would overwrite the scope's
    // own `departmentId` key and a hand-edited URL would WIDEN the query.
    const { rows, total } = await directoryPeople(term.id, { departmentId: tria.id }, scope, 1, 50);

    expect(total).toBe(0);
    expect(rows).toEqual([]);
  });

  it("returns no attendings, who belong to no department", async () => {
    const { scope } = await scopedToNurs();
    await prisma.attending.create({
      data: { scheduleName: "Dr. Chen", fullName: "Dr. Casey Chen", isActive: true },
    });

    expect(await directoryAttendings(scope)).toEqual([]);
  });

  it("leaves the attending count out of the summary as well", async () => {
    const { term, scope } = await scopedToNurs();
    await prisma.attending.create({
      data: { scheduleName: "Dr. Chen", fullName: "Dr. Casey Chen", isActive: true },
    });

    expect((await directorySummary(term.id, scope)).attendings).toBe(0);
    expect((await directorySummary(term.id, null)).attendings).toBe(1);
  });
});

describe("directoryEmails", () => {
  it("resolves a Yale address from the NetID and falls back to the contact address", async () => {
    const { term } = await seedRoster();

    const emails = await directoryEmails(term.id, {}, null);

    // Dana and Bo have NetIDs; Vic has only a contact address. Name order.
    expect(emails).toEqual(["bb333@yale.edu", "dd111@yale.edu", "vic@example.com"]);
  });

  it("lists a dual-department member once", async () => {
    const { term } = await seedRoster();

    const emails = await directoryEmails(term.id, {}, null);

    // Bo holds two seats. A To: field must not carry the same address twice.
    expect(emails.filter((e) => e === "bb333@yale.edu")).toHaveLength(1);
  });

  it("drops a person with neither a NetID nor a contact address", async () => {
    const { term, nurs } = await seedRoster();
    const ghost = await prisma.person.create({ data: { name: "No Contact" } });
    await seat(ghost.id, term.id, nurs.id, "VOLUNTEER");

    const emails = await directoryEmails(term.id, {}, null);

    // "" pasted into a To: field is a bounce, not an address.
    expect(emails).not.toContain("");
    expect(emails).toHaveLength(3);
  });

  it("follows the same filters as the roster", async () => {
    const { term, nurs } = await seedRoster();

    expect(await directoryEmails(term.id, { departmentId: nurs.id }, null)).toEqual([
      "bb333@yale.edu",
      "dd111@yale.edu",
    ]);
    expect(await directoryEmails(term.id, { kind: "VOLUNTEER" }, null)).toEqual([
      "bb333@yale.edu",
      "vic@example.com",
    ]);
  });

  it("returns every match rather than one page of them", async () => {
    const { term, nurs } = await seedRoster();
    for (let i = 0; i < 60; i++) {
      const extra = await prisma.person.create({
        data: { name: `Extra ${String(i).padStart(2, "0")}`, netId: `ex${i}` },
      });
      await seat(extra.id, term.id, nurs.id, "VOLUNTEER");
    }

    // The roster page shows 50. A list that silently stopped there would be
    // worse than no list: the department you meant to mail is missing thirteen.
    expect(await directoryEmails(term.id, {}, null)).toHaveLength(63);
  });

  it("stays inside the viewer's scope", async () => {
    const roster = await seedRoster();
    await grantToDirectorKind("volunteers.view_directory_own_dept");
    const scope = await directoryScopeFor(roster.both.id);

    const emails = await directoryEmails(roster.term.id, {}, scope);

    expect(emails).toEqual(["bb333@yale.edu", "dd111@yale.edu"]);
  });

  it("returns nothing rather than throwing when no term is active", async () => {
    expect(await directoryEmails(null, {}, null)).toEqual([]);
  });
});
