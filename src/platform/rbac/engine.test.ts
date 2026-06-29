import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { can, getEffectivePermissions, hasPermission } from "./engine";

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

  it("auto-attaches Director role from active-term membership kind", async () => {
    const f = await fixture();
    const person = await prisma.person.create({ data: { name: "Dir" } });
    await prisma.termMembership.create({
      data: { personId: person.id, termId: f.term.id, departmentId: f.vadm.id, kind: "DIRECTOR" },
    });
    expect(await can(person.id, "volunteers.view")).toBe(true);
    expect(await can(person.id, "recruitment.manage_cycle")).toBe(false);
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
