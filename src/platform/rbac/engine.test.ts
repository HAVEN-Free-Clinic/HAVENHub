import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { can, getEffectivePermissions, hasPermission, permissionDepartmentIds } from "./engine";

async function fixture() {
  const term = await prisma.term.create({
    data: {
      code: "SU26",
      name: "Summer 2026",
      startDate: new Date("2026-05-30"),
      endDate: new Date("2026-09-26"),
      status: "ACTIVE",
    },
  });
  const oldTerm = await prisma.term.create({
    data: {
      code: "SP26",
      name: "Spring 2026",
      startDate: new Date("2026-01-10"),
      endDate: new Date("2026-05-01"),
      status: "ARCHIVED",
    },
  });
  const itcm = await prisma.department.create({ data: { code: "ITCM", name: "IT" } });
  const vadm = await prisma.department.create({ data: { code: "VADM", name: "Vol Admin" } });

  const adminRole = await prisma.role.create({
    data: { name: "Platform Admin", isSystem: true, grants: { create: [{ permission: "*" }] } },
  });
  const directorRole = await prisma.role.create({
    data: {
      name: "Director",
      isSystem: true,
      grants: { create: [{ permission: "schedule.view" }, { permission: "volunteers.view" }] },
    },
  });
  const volunteerRole = await prisma.role.create({
    data: { name: "Volunteer", isSystem: true, grants: { create: [{ permission: "schedule.view" }] } },
  });
  const recruiterRole = await prisma.role.create({
    data: {
      name: "Recruitment Manager",
      grants: { create: [{ permission: "recruitment.manage_cycle" }] },
    },
  });

  // Baseline access is now provisioned as kind-target assignments (decouple),
  // mirroring prisma/seed.ts and the backfill migration. No code auto-attach.
  await prisma.roleAssignment.create({
    data: { roleId: directorRole.id, kind: "DIRECTOR", termId: null },
  });
  await prisma.roleAssignment.create({
    data: { roleId: volunteerRole.id, kind: "VOLUNTEER", termId: null },
  });

  return { term, oldTerm, itcm, vadm, adminRole, directorRole, volunteerRole, recruiterRole };
}

describe("rbac engine", () => {
  beforeEach(resetDb);

  it("grants everything via a global '*' assignment", async () => {
    const f = await fixture();
    const person = await prisma.person.create({ data: { name: "Admin" } });
    await prisma.roleAssignment.create({
      data: { roleId: f.adminRole.id, personId: person.id, termId: null },
    });
    expect(await can(person.id, "anything.at_all")).toBe(true);
  });

  it("grants Director baseline via the kind-target assignment", async () => {
    const f = await fixture();
    const person = await prisma.person.create({ data: { name: "Dir" } });
    await prisma.termMembership.create({
      data: { personId: person.id, termId: f.term.id, departmentId: f.vadm.id, kind: "DIRECTOR" },
    });
    expect(await can(person.id, "volunteers.view")).toBe(true);
    expect(await can(person.id, "recruitment.manage_cycle")).toBe(false);
  });

  it("grants nothing from membership kind alone once the kind assignment is removed", async () => {
    const f = await fixture();
    await prisma.roleAssignment.deleteMany({ where: { kind: "DIRECTOR" } });
    const person = await prisma.person.create({ data: { name: "Dir no-assign" } });
    await prisma.termMembership.create({
      data: { personId: person.id, termId: f.term.id, departmentId: f.vadm.id, kind: "DIRECTOR" },
    });
    // Proves the hardcoded auto-attach is gone: kind alone confers no access.
    expect(await can(person.id, "volunteers.view")).toBe(false);
  });

  it("grants department-assigned roles to active members of that department", async () => {
    const f = await fixture();
    const person = await prisma.person.create({ data: { name: "SRR member" } });
    await prisma.termMembership.create({
      data: { personId: person.id, termId: f.term.id, departmentId: f.itcm.id, kind: "VOLUNTEER" },
    });
    await prisma.roleAssignment.create({
      data: { roleId: f.recruiterRole.id, departmentId: f.itcm.id, termId: f.term.id },
    });
    expect(await can(person.id, "recruitment.manage_cycle")).toBe(true);
  });

  it("ignores assignments scoped to a non-active term", async () => {
    const f = await fixture();
    const person = await prisma.person.create({ data: { name: "Old" } });
    await prisma.roleAssignment.create({
      data: { roleId: f.recruiterRole.id, personId: person.id, termId: f.oldTerm.id },
    });
    expect(await can(person.id, "recruitment.manage_cycle")).toBe(false);
  });

  it("ignores REMOVED memberships", async () => {
    const f = await fixture();
    const person = await prisma.person.create({ data: { name: "Removed" } });
    await prisma.termMembership.create({
      data: {
        personId: person.id,
        termId: f.term.id,
        departmentId: f.vadm.id,
        kind: "DIRECTOR",
        status: "REMOVED",
      },
    });
    expect(await can(person.id, "volunteers.view")).toBe(false);
  });

  it("returns the full effective permission set", async () => {
    const f = await fixture();
    const person = await prisma.person.create({ data: { name: "Vol" } });
    await prisma.termMembership.create({
      data: { personId: person.id, termId: f.term.id, departmentId: f.vadm.id, kind: "VOLUNTEER" },
    });
    const perms = await getEffectivePermissions(person.id);
    expect(perms.has("schedule.view")).toBe(true);
    expect(perms.size).toBe(1);
    expect(perms.has("volunteers.view")).toBe(false);
  });

  it("grants kind-target assignments to active members of that kind", async () => {
    const f = await fixture();
    const vol = await prisma.person.create({ data: { name: "Vol" } });
    const dir = await prisma.person.create({ data: { name: "Dir" } });
    await prisma.termMembership.create({ data: { personId: vol.id, termId: f.term.id, departmentId: f.vadm.id, kind: "VOLUNTEER" } });
    await prisma.termMembership.create({ data: { personId: dir.id, termId: f.term.id, departmentId: f.vadm.id, kind: "DIRECTOR" } });
    await prisma.roleAssignment.create({ data: { roleId: f.recruiterRole.id, kind: "VOLUNTEER", termId: f.term.id } });

    expect(await can(vol.id, "recruitment.manage_cycle")).toBe(true);
    expect(await can(dir.id, "recruitment.manage_cycle")).toBe(false);
  });

  it("ignores a kind-target assignment scoped to a non-active term", async () => {
    const f = await fixture();
    const vol = await prisma.person.create({ data: { name: "Vol2" } });
    await prisma.termMembership.create({ data: { personId: vol.id, termId: f.term.id, departmentId: f.vadm.id, kind: "VOLUNTEER" } });
    await prisma.roleAssignment.create({ data: { roleId: f.recruiterRole.id, kind: "VOLUNTEER", termId: f.oldTerm.id } });

    expect(await can(vol.id, "recruitment.manage_cycle")).toBe(false);
  });
});

describe("hasPermission", () => {
  it("honors the wildcard", () => {
    expect(hasPermission(new Set(["*"]), "anything.at_all")).toBe(true);
    expect(hasPermission(new Set(["schedule.view"]), "schedule.edit_all")).toBe(false);
  });
});

describe("permissionDepartmentIds", () => {
  beforeEach(resetDb);

  /** A fresh role granting exactly `permission`. */
  async function roleGranting(permission: string) {
    return prisma.role.create({
      data: {
        name: `R-${permission}-${Date.now()}-${Math.random()}`,
        grants: { create: [{ permission }] },
      },
    });
  }

  it("limits a kind-targeted grant to memberships of that kind", async () => {
    const f = await fixture();
    const person = await prisma.person.create({ data: { name: "Dir+Vol" } });
    await prisma.termMembership.create({
      data: { personId: person.id, termId: f.term.id, departmentId: f.itcm.id, kind: "DIRECTOR" },
    });
    await prisma.termMembership.create({
      data: { personId: person.id, termId: f.term.id, departmentId: f.vadm.id, kind: "VOLUNTEER" },
    });
    const role = await roleGranting("schedule.edit_own_dept");
    await prisma.roleAssignment.create({
      data: { roleId: role.id, kind: "DIRECTOR", termId: null },
    });

    const ids = await permissionDepartmentIds(person.id, "schedule.edit_own_dept");
    expect(ids).toEqual([f.itcm.id]);
    // The flat view still says yes -- which is exactly why the scoped one exists.
    expect(await can(person.id, "schedule.edit_own_dept")).toBe(true);
  });

  it("limits a department-targeted grant to that department", async () => {
    const f = await fixture();
    const person = await prisma.person.create({ data: { name: "TwoDept" } });
    await prisma.termMembership.create({
      data: { personId: person.id, termId: f.term.id, departmentId: f.itcm.id, kind: "VOLUNTEER" },
    });
    await prisma.termMembership.create({
      data: { personId: person.id, termId: f.term.id, departmentId: f.vadm.id, kind: "VOLUNTEER" },
    });
    const role = await roleGranting("schedule.edit_own_dept");
    await prisma.roleAssignment.create({
      data: { roleId: role.id, departmentId: f.itcm.id, termId: null },
    });

    expect(await permissionDepartmentIds(person.id, "schedule.edit_own_dept")).toEqual([f.itcm.id]);
  });

  it("spreads a person-targeted grant across every member department", async () => {
    const f = await fixture();
    const person = await prisma.person.create({ data: { name: "PersonGrant" } });
    await prisma.termMembership.create({
      data: { personId: person.id, termId: f.term.id, departmentId: f.itcm.id, kind: "DIRECTOR" },
    });
    await prisma.termMembership.create({
      data: { personId: person.id, termId: f.term.id, departmentId: f.vadm.id, kind: "VOLUNTEER" },
    });
    const role = await roleGranting("schedule.edit_own_dept");
    await prisma.roleAssignment.create({
      data: { roleId: role.id, personId: person.id, termId: null },
    });

    const ids = await permissionDepartmentIds(person.id, "schedule.edit_own_dept");
    expect([...ids].sort()).toEqual([f.itcm.id, f.vadm.id].sort());
  });

  it("returns [] for a permission nobody granted", async () => {
    const f = await fixture();
    const person = await prisma.person.create({ data: { name: "NoGrant" } });
    await prisma.termMembership.create({
      data: { personId: person.id, termId: f.term.id, departmentId: f.itcm.id, kind: "VOLUNTEER" },
    });

    expect(await permissionDepartmentIds(person.id, "schedule.edit_own_dept")).toEqual([]);
  });

  it("treats a wildcard role as granting the permission with its own scope", async () => {
    const f = await fixture();
    const person = await prisma.person.create({ data: { name: "Wildcard" } });
    await prisma.termMembership.create({
      data: { personId: person.id, termId: f.term.id, departmentId: f.itcm.id, kind: "DIRECTOR" },
    });
    await prisma.termMembership.create({
      data: { personId: person.id, termId: f.term.id, departmentId: f.vadm.id, kind: "VOLUNTEER" },
    });
    await prisma.roleAssignment.create({
      data: { roleId: f.adminRole.id, kind: "DIRECTOR", termId: null },
    });

    expect(await permissionDepartmentIds(person.id, "schedule.edit_own_dept")).toEqual([f.itcm.id]);
  });

  it("resolves against an explicit non-active term when asked", async () => {
    const f = await fixture();
    const person = await prisma.person.create({ data: { name: "NextTerm" } });
    await prisma.termMembership.create({
      data: { personId: person.id, termId: f.oldTerm.id, departmentId: f.vadm.id, kind: "VOLUNTEER" },
    });
    const role = await roleGranting("schedule.manage_requests");
    await prisma.roleAssignment.create({
      data: { roleId: role.id, personId: person.id, termId: null },
    });

    // No ACTIVE-term membership, so the default (active-term) view is empty.
    expect(await permissionDepartmentIds(person.id, "schedule.manage_requests")).toEqual([]);
    expect(
      await permissionDepartmentIds(person.id, "schedule.manage_requests", f.oldTerm.id),
    ).toEqual([f.vadm.id]);
  });
});
