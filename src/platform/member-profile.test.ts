/**
 * Integration tests for the member-profile scope.
 *
 * The rule under test is the one that lets a director click a name on the
 * schedule and find out why that volunteer is not cleared, WITHOUT letting them
 * do the same for a department that is not theirs.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { resetDb } from "@/platform/test/db";
import { prisma } from "@/platform/db";
import { canViewMemberProfile, viewableMemberIds } from "./member-profile";

beforeEach(resetDb);

async function seedTerm() {
  return prisma.term.create({
    data: {
      code: `MP-${Date.now()}-${Math.random()}`,
      name: "Member Profile Term",
      startDate: new Date("2026-01-12T12:00:00Z"),
      endDate: new Date("2026-05-12T12:00:00Z"),
      status: "ACTIVE",
    },
  });
}

async function seedDept(code: string) {
  return prisma.department.upsert({
    where: { code },
    update: {},
    create: { code, name: `${code} Department` },
  });
}

async function member(
  personId: string,
  termId: string,
  departmentId: string,
  kind: "DIRECTOR" | "VOLUNTEER" = "VOLUNTEER",
  status: "ACTIVE" | "REMOVED" = "ACTIVE",
) {
  return prisma.termMembership.create({
    data: { personId, termId, departmentId, kind, status },
  });
}

async function grant(personId: string, permission: string) {
  const role = await prisma.role.create({
    data: { name: `MP-${permission}-${Date.now()}-${Math.random()}`, grants: { create: [{ permission }] } },
  });
  await prisma.roleAssignment.create({ data: { roleId: role.id, personId } });
}

describe("member profile scope", () => {
  it("lets a director reach their own department's active members", async () => {
    const term = await seedTerm();
    const dept = await seedDept("MPA");
    const director = await prisma.person.create({ data: { name: "Director" } });
    const vol = await prisma.person.create({ data: { name: "Volunteer" } });
    await member(director.id, term.id, dept.id, "DIRECTOR");
    await member(vol.id, term.id, dept.id);
    await grant(director.id, "volunteers.view");

    expect(await canViewMemberProfile(director.id, vol.id)).toBe(true);
  });

  it("stops a director at the edge of their own departments", async () => {
    const term = await seedTerm();
    const mine = await seedDept("MPA");
    const theirs = await seedDept("MPB");
    const director = await prisma.person.create({ data: { name: "Director" } });
    const stranger = await prisma.person.create({ data: { name: "Other dept volunteer" } });
    await member(director.id, term.id, mine.id, "DIRECTOR");
    await member(stranger.id, term.id, theirs.id);
    await grant(director.id, "volunteers.view");

    expect(await canViewMemberProfile(director.id, stranger.id)).toBe(false);
  });

  it("follows a delegation the way the compliance roster does", async () => {
    const term = await seedTerm();
    const parent = await seedDept("MPA");
    const child = await seedDept("MPB");
    await prisma.departmentDelegation.create({
      data: { managerDepartmentId: parent.id, managedDepartmentId: child.id },
    });
    const director = await prisma.person.create({ data: { name: "Director" } });
    const vol = await prisma.person.create({ data: { name: "Delegated volunteer" } });
    await member(director.id, term.id, parent.id, "DIRECTOR");
    await member(vol.id, term.id, child.id);
    await grant(director.id, "volunteers.view");

    expect(await canViewMemberProfile(director.id, vol.id)).toBe(true);
  });

  it("reaches everyone for a compliance manager", async () => {
    const term = await seedTerm();
    const dept = await seedDept("MPA");
    const manager = await prisma.person.create({ data: { name: "Compliance manager" } });
    const vol = await prisma.person.create({ data: { name: "Volunteer" } });
    await member(vol.id, term.id, dept.id);
    await grant(manager.id, "volunteers.manage_compliance");

    expect(await canViewMemberProfile(manager.id, vol.id)).toBe(true);
  });

  // Managing a department's SCHEDULE is not the same as being responsible for
  // its volunteers' clearance, so schedule.edit_all alone must not open this.
  it("refuses someone holding only schedule permissions", async () => {
    const term = await seedTerm();
    const dept = await seedDept("MPA");
    const scheduler = await prisma.person.create({ data: { name: "Clinic scheduler" } });
    const vol = await prisma.person.create({ data: { name: "Volunteer" } });
    await member(vol.id, term.id, dept.id);
    await grant(scheduler.id, "schedule.edit_all");

    expect(await canViewMemberProfile(scheduler.id, vol.id)).toBe(false);
  });

  it("refuses a plain volunteer looking up a teammate", async () => {
    const term = await seedTerm();
    const dept = await seedDept("MPA");
    const a = await prisma.person.create({ data: { name: "Volunteer A" } });
    const b = await prisma.person.create({ data: { name: "Volunteer B" } });
    await member(a.id, term.id, dept.id);
    await member(b.id, term.id, dept.id);

    expect(await canViewMemberProfile(a.id, b.id)).toBe(false);
  });

  it("does not reach someone whose membership is REMOVED", async () => {
    const term = await seedTerm();
    const dept = await seedDept("MPA");
    const director = await prisma.person.create({ data: { name: "Director" } });
    const departed = await prisma.person.create({ data: { name: "Departed" } });
    await member(director.id, term.id, dept.id, "DIRECTOR");
    await member(departed.id, term.id, dept.id, "VOLUNTEER", "REMOVED");
    await grant(director.id, "volunteers.view");

    expect(await canViewMemberProfile(director.id, departed.id)).toBe(false);
  });

  it("viewableMemberIds returns exactly the in-scope subset of a roster", async () => {
    const term = await seedTerm();
    const mine = await seedDept("MPA");
    const theirs = await seedDept("MPB");
    const director = await prisma.person.create({ data: { name: "Director" } });
    const ours = await prisma.person.create({ data: { name: "Ours" } });
    const stranger = await prisma.person.create({ data: { name: "Theirs" } });
    await member(director.id, term.id, mine.id, "DIRECTOR");
    await member(ours.id, term.id, mine.id);
    await member(stranger.id, term.id, theirs.id);
    await grant(director.id, "volunteers.view");

    const ids = await viewableMemberIds(director.id, [ours.id, stranger.id]);
    expect([...ids]).toEqual([ours.id]);
  });

  it("viewableMemberIds is empty for an empty input, without querying", async () => {
    const stranger = await prisma.person.create({ data: { name: "Nobody" } });
    expect(await viewableMemberIds(stranger.id, [])).toEqual(new Set());
  });
});
