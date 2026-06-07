/**
 * Tests for canViewCertificate access control.
 *
 * Rules:
 *   1. Self: viewer === owner -> true
 *   2. volunteers.manage_compliance permission -> true
 *   3. volunteers.view permission AND viewer is ACTIVE DIRECTOR in active term
 *      in a department where owner has ACTIVE membership -> true
 *   4. Anything else -> false
 */

import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { canViewCertificate } from "./access";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function createPerson(name: string, netId?: string) {
  return prisma.person.create({ data: { name, netId } });
}

async function createTerm(status: "ACTIVE" | "ARCHIVED" | "PLANNING" = "ACTIVE", code = "SU26") {
  return prisma.term.create({
    data: {
      code,
      name: `Term ${code}`,
      startDate: new Date("2026-05-01"),
      endDate: new Date("2026-08-31"),
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

async function createMembership(
  personId: string,
  termId: string,
  departmentId: string,
  kind: "VOLUNTEER" | "DIRECTOR",
  status: "ACTIVE" | "REMOVED" = "ACTIVE"
) {
  return prisma.termMembership.create({
    data: { personId, termId, departmentId, kind, status },
  });
}

async function grantPermission(personId: string, permission: string) {
  const role = await prisma.role.create({
    data: { name: `Role-${permission}-${Date.now()}`, isSystem: false, grants: { create: [{ permission }] } },
  });
  await prisma.roleAssignment.create({ data: { roleId: role.id, personId, termId: null } });
}

async function delegate(managerId: string, managedId: string) {
  return prisma.departmentDelegation.create({
    data: { managerDepartmentId: managerId, managedDepartmentId: managedId },
  });
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(resetDb);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("canViewCertificate", () => {
  it("returns true when viewer is the owner (self access)", async () => {
    const person = await createPerson("Alice", "al001");
    expect(await canViewCertificate(person.id, person.id)).toBe(true);
  });

  it("returns true when viewer has volunteers.manage_compliance permission", async () => {
    const viewer = await createPerson("Manager", "mgr001");
    const owner = await createPerson("Volunteer", "vol001");
    await grantPermission(viewer.id, "volunteers.manage_compliance");

    expect(await canViewCertificate(viewer.id, owner.id)).toBe(true);
  });

  it("returns true when viewer has volunteers.view AND is ACTIVE DIRECTOR in same department as owner in active term", async () => {
    const term = await createTerm("ACTIVE");
    const dept = await createDepartment("ITCM");
    const viewer = await createPerson("Director", "dir001");
    const owner = await createPerson("Member", "mem001");

    await grantPermission(viewer.id, "volunteers.view");
    await createMembership(viewer.id, term.id, dept.id, "DIRECTOR", "ACTIVE");
    await createMembership(owner.id, term.id, dept.id, "VOLUNTEER", "ACTIVE");

    expect(await canViewCertificate(viewer.id, owner.id)).toBe(true);
  });

  it("returns false when a plain volunteer (no volunteers.view, no directorships) tries to view another person", async () => {
    const term = await createTerm("ACTIVE");
    const dept = await createDepartment("EXEC");
    const viewer = await createPerson("Vol", "vol002");
    const owner = await createPerson("Other", "oth002");

    await createMembership(viewer.id, term.id, dept.id, "VOLUNTEER", "ACTIVE");
    await createMembership(owner.id, term.id, dept.id, "VOLUNTEER", "ACTIVE");

    expect(await canViewCertificate(viewer.id, owner.id)).toBe(false);
  });

  it("returns false when viewer is DIRECTOR in a DIFFERENT department than the owner", async () => {
    const term = await createTerm("ACTIVE");
    const deptA = await createDepartment("ITCM");
    const deptB = await createDepartment("SRR");
    const viewer = await createPerson("DirA", "dirA");
    const owner = await createPerson("MemB", "memB");

    await grantPermission(viewer.id, "volunteers.view");
    await createMembership(viewer.id, term.id, deptA.id, "DIRECTOR", "ACTIVE");
    await createMembership(owner.id, term.id, deptB.id, "VOLUNTEER", "ACTIVE");

    expect(await canViewCertificate(viewer.id, owner.id)).toBe(false);
  });

  it("returns false when viewer has volunteers.view but their directorship is REMOVED (not ACTIVE)", async () => {
    const term = await createTerm("ACTIVE");
    const dept = await createDepartment("ITCM");
    const viewer = await createPerson("RemovedDir", "rdir01");
    const owner = await createPerson("OwnerA", "ownr01");

    await grantPermission(viewer.id, "volunteers.view");
    // Directorship exists but status is REMOVED -- should not grant access
    await createMembership(viewer.id, term.id, dept.id, "DIRECTOR", "REMOVED");
    await createMembership(owner.id, term.id, dept.id, "VOLUNTEER", "ACTIVE");

    expect(await canViewCertificate(viewer.id, owner.id)).toBe(false);
  });

  it("returns false when viewer is ACTIVE DIRECTOR in the same dept but the owner's membership is REMOVED", async () => {
    const term = await createTerm("ACTIVE");
    const dept = await createDepartment("SRR");
    const viewer = await createPerson("DirActive", "dira01");
    const owner = await createPerson("RemovedMem", "rmem01");

    await grantPermission(viewer.id, "volunteers.view");
    await createMembership(viewer.id, term.id, dept.id, "DIRECTOR", "ACTIVE");
    // Owner's membership is REMOVED -- query filters status ACTIVE, so this should deny
    await createMembership(owner.id, term.id, dept.id, "VOLUNTEER", "REMOVED");

    expect(await canViewCertificate(viewer.id, owner.id)).toBe(false);
  });

  it("returns true via delegation: a PCAR director can view an SCTP member's certificate", async () => {
    const term = await createTerm("ACTIVE");
    const pcar = await createDepartment("PCAR");
    const sctp = await createDepartment("SCTP");
    await delegate(pcar.id, sctp.id);

    const viewer = await createPerson("PCAR Dir", "pcd01");
    const owner = await createPerson("SCTP Member", "sctpm01");

    await grantPermission(viewer.id, "volunteers.view");
    await createMembership(viewer.id, term.id, pcar.id, "DIRECTOR", "ACTIVE");
    await createMembership(owner.id, term.id, sctp.id, "VOLUNTEER", "ACTIVE");

    expect(await canViewCertificate(viewer.id, owner.id)).toBe(true);
  });

  it("returns false: delegation is one-way, an SCTP director cannot view a PCAR member's certificate", async () => {
    const term = await createTerm("ACTIVE");
    const pcar = await createDepartment("PCAR");
    const sctp = await createDepartment("SCTP");
    await delegate(pcar.id, sctp.id);

    const viewer = await createPerson("SCTP Dir", "scd01");
    const owner = await createPerson("PCAR Member", "pcarm01");

    await grantPermission(viewer.id, "volunteers.view");
    await createMembership(viewer.id, term.id, sctp.id, "DIRECTOR", "ACTIVE");
    await createMembership(owner.id, term.id, pcar.id, "VOLUNTEER", "ACTIVE");

    expect(await canViewCertificate(viewer.id, owner.id)).toBe(false);
  });
});
