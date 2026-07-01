import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { peopleWithAnyPermission } from "./holders";

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

  const adminRole = await prisma.role.create({
    data: { name: "Platform Admin", isSystem: true, grants: { create: [{ permission: "*" }] } },
  });
  const complianceRole = await prisma.role.create({
    data: {
      name: "Compliance Manager",
      grants: { create: [{ permission: "volunteers.view" }, { permission: "volunteers.manage_compliance" }] },
    },
  });
  // A role that confers admin.access literally (not via the "*" wildcard).
  const adminAccessRole = await prisma.role.create({
    data: { name: "Admin Access", grants: { create: [{ permission: "admin.access" }] } },
  });
  // A baseline system role that is auto-attached from membership kind.
  const volunteerRole = await prisma.role.create({
    data: { name: "Volunteer", isSystem: true, grants: { create: [{ permission: "my-info.access" }] } },
  });

  return { term, oldTerm, itcm, adminRole, complianceRole, adminAccessRole, volunteerRole };
}

describe("peopleWithAnyPermission", () => {
  beforeEach(resetDb);

  it("includes a person with a direct global assignment to a granting role", async () => {
    const f = await fixture();
    const person = await prisma.person.create({ data: { name: "Cathy Compliance", contactEmail: "cathy@x.org" } });
    await prisma.roleAssignment.create({
      data: { roleId: f.complianceRole.id, personId: person.id, termId: null },
    });

    const holders = await peopleWithAnyPermission(["volunteers.manage_compliance"]);
    expect(holders.map((h) => h.id)).toEqual([person.id]);
  });

  it("includes wildcard '*' admins even when querying a specific permission", async () => {
    const f = await fixture();
    const admin = await prisma.person.create({ data: { name: "Adam Admin" } });
    await prisma.roleAssignment.create({
      data: { roleId: f.adminRole.id, personId: admin.id, termId: null },
    });

    const holders = await peopleWithAnyPermission(["volunteers.manage_compliance"]);
    expect(holders.map((h) => h.id)).toEqual([admin.id]);
  });

  it("includes holders of a literal admin.access grant when queried", async () => {
    const f = await fixture();
    const person = await prisma.person.create({ data: { name: "Andy Access" } });
    await prisma.roleAssignment.create({
      data: { roleId: f.adminAccessRole.id, personId: person.id, termId: null },
    });

    const onlyCompliance = await peopleWithAnyPermission(["volunteers.manage_compliance"]);
    expect(onlyCompliance.map((h) => h.id)).toEqual([]);

    const both = await peopleWithAnyPermission(["volunteers.manage_compliance", "admin.access"]);
    expect(both.map((h) => h.id)).toEqual([person.id]);
  });

  it("includes active members of a department-scoped assignment", async () => {
    const f = await fixture();
    const person = await prisma.person.create({ data: { name: "Dana Dept" } });
    await prisma.termMembership.create({
      data: { personId: person.id, termId: f.term.id, departmentId: f.itcm.id, kind: "VOLUNTEER" },
    });
    await prisma.roleAssignment.create({
      data: { roleId: f.complianceRole.id, departmentId: f.itcm.id, termId: f.term.id },
    });

    const holders = await peopleWithAnyPermission(["volunteers.manage_compliance"]);
    expect(holders.map((h) => h.id)).toEqual([person.id]);
  });

  it("includes active members of a kind-scoped assignment", async () => {
    const f = await fixture();
    const dir = await prisma.person.create({ data: { name: "Dirk Director" } });
    await prisma.termMembership.create({
      data: { personId: dir.id, termId: f.term.id, departmentId: f.itcm.id, kind: "DIRECTOR" },
    });
    await prisma.roleAssignment.create({
      data: { roleId: f.complianceRole.id, kind: "DIRECTOR", termId: f.term.id },
    });

    const holders = await peopleWithAnyPermission(["volunteers.manage_compliance"]);
    expect(holders.map((h) => h.id)).toEqual([dir.id]);
  });

  it("includes active members via a kind-target assignment for the baseline Volunteer system role", async () => {
    const f = await fixture();
    const vol = await prisma.person.create({ data: { name: "Vera Volunteer" } });
    await prisma.termMembership.create({
      data: { personId: vol.id, termId: f.term.id, departmentId: f.itcm.id, kind: "VOLUNTEER" },
    });
    // Baseline Volunteer access is provisioned as a kind-target RoleAssignment
    // (matching engine.ts and the decouple in #158). No code auto-attach.
    await prisma.roleAssignment.create({
      data: { roleId: f.volunteerRole.id, kind: "VOLUNTEER", termId: null },
    });

    const holders = await peopleWithAnyPermission(["my-info.access"]);
    expect(holders.map((h) => h.id)).toEqual([vol.id]);
  });

  it("ignores assignments scoped to a non-active term", async () => {
    const f = await fixture();
    const person = await prisma.person.create({ data: { name: "Olive Old" } });
    await prisma.roleAssignment.create({
      data: { roleId: f.complianceRole.id, personId: person.id, termId: f.oldTerm.id },
    });

    const holders = await peopleWithAnyPermission(["volunteers.manage_compliance"]);
    expect(holders).toEqual([]);
  });

  it("ignores REMOVED memberships for department/kind targets", async () => {
    const f = await fixture();
    const person = await prisma.person.create({ data: { name: "Rex Removed" } });
    await prisma.termMembership.create({
      data: {
        personId: person.id,
        termId: f.term.id,
        departmentId: f.itcm.id,
        kind: "VOLUNTEER",
        status: "REMOVED",
      },
    });
    await prisma.roleAssignment.create({
      data: { roleId: f.complianceRole.id, departmentId: f.itcm.id, termId: f.term.id },
    });

    const holders = await peopleWithAnyPermission(["volunteers.manage_compliance"]);
    expect(holders).toEqual([]);
  });

  it("excludes people who are not ACTIVE", async () => {
    const f = await fixture();
    const person = await prisma.person.create({
      data: { name: "Iris Inactive", status: "OFFBOARDED" },
    });
    await prisma.roleAssignment.create({
      data: { roleId: f.complianceRole.id, personId: person.id, termId: null },
    });

    const holders = await peopleWithAnyPermission(["volunteers.manage_compliance"]);
    expect(holders).toEqual([]);
  });

  it("returns each qualifying person once even via multiple paths", async () => {
    const f = await fixture();
    const person = await prisma.person.create({ data: { name: "Donna Double" } });
    await prisma.termMembership.create({
      data: { personId: person.id, termId: f.term.id, departmentId: f.itcm.id, kind: "VOLUNTEER" },
    });
    // qualifies directly AND via the department-scoped assignment
    await prisma.roleAssignment.create({
      data: { roleId: f.complianceRole.id, personId: person.id, termId: null },
    });
    await prisma.roleAssignment.create({
      data: { roleId: f.complianceRole.id, departmentId: f.itcm.id, termId: f.term.id },
    });

    const holders = await peopleWithAnyPermission(["volunteers.manage_compliance"]);
    expect(holders.map((h) => h.id)).toEqual([person.id]);
  });

  it("returns notification-shaped fields", async () => {
    const f = await fixture();
    const person = await prisma.person.create({
      data: { name: "Cathy Compliance", contactEmail: "cathy@x.org", entraObjectId: "entra-1" },
    });
    await prisma.roleAssignment.create({
      data: { roleId: f.complianceRole.id, personId: person.id, termId: null },
    });

    const holders = await peopleWithAnyPermission(["volunteers.manage_compliance"]);
    expect(holders).toEqual([
      { id: person.id, name: "Cathy Compliance", contactEmail: "cathy@x.org", entraObjectId: "entra-1" },
    ]);
  });

  it("does not report a DIRECTOR member once the kind-target assignment is removed", async () => {
    await resetDb();
    const term = await prisma.term.create({
      data: { code: "SU26", name: "Summer 2026", startDate: new Date("2026-05-30"), endDate: new Date("2026-09-26"), status: "ACTIVE" },
    });
    const dept = await prisma.department.create({ data: { code: "TEST", name: "Test Dept" } });
    const dir = await prisma.role.create({
      data: { name: "Director", isSystem: true, grants: { create: [{ permission: "volunteers.review" }] } },
    });
    const person = await prisma.person.create({ data: { name: "Dana Director", status: "ACTIVE" } });
    await prisma.termMembership.create({
      data: { termId: term.id, personId: person.id, departmentId: dept.id, kind: "DIRECTOR", status: "ACTIVE" },
    });
    const assignment = await prisma.roleAssignment.create({
      data: { roleId: dir.id, kind: "DIRECTOR", termId: null },
    });

    // With the kind-target assignment present, Dana holds the permission.
    expect((await peopleWithAnyPermission(["volunteers.review"])).map((p) => p.id)).toContain(person.id);

    // Remove the wiring (as the roles page can). The forward resolver would no
    // longer grant the permission; the inverse resolver must agree and stop
    // reporting Dana. Pre-fix, the AUTO_ROLE_KIND fold-in loop re-added DIRECTOR
    // kind from the role name even with no assignment, so the second assertion
    // would fail. Post-fix, kinds derive only from matched RoleAssignment rows.
    await prisma.roleAssignment.delete({ where: { id: assignment.id } });
    expect((await peopleWithAnyPermission(["volunteers.review"])).map((p) => p.id)).not.toContain(person.id);
  });
});
