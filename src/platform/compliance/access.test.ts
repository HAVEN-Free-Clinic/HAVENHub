/**
 * Tests for canViewCertificate access control, and for canViewAllCompliance --
 * the clinic-wide compliance read that rule 2 now delegates to.
 *
 * Rules:
 *   1. Self: viewer === owner -> true
 *   2. the clinic-wide compliance read (volunteers.view_compliance OR
 *      volunteers.manage_compliance) -> true
 *   3. volunteers.view permission AND viewer is ACTIVE DIRECTOR in active term
 *      in a department where owner has ACTIVE membership -> true
 *   4. Anything else -> false
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { canViewCertificate, canViewAllCompliance, hasViewAllCompliance } from "./access";

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

/**
 * Counter, not Date.now() (audit 14, determinism). Role.name is unique, so two
 * grants of the SAME permission inside one millisecond collide and the second
 * create fails P2002 -- the shape the 11th audit found on term codes. No test
 * here grants twice today, which is exactly why the trap is easy to walk into
 * later; the case at the bottom of this file holds the fixture to it.
 */
let roleSeq = 0;

async function grantPermission(personId: string, permission: string) {
  const role = await prisma.role.create({
    data: { name: `Role-${permission}-${++roleSeq}`, isSystem: false, grants: { create: [{ permission }] } },
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

  it("returns true when viewer has volunteers.view_compliance, with no manage half", async () => {
    // The read/write split: view_compliance reaches the certificate exactly as
    // manage_compliance does. What it must NOT reach is verifyCertificate and
    // setCompletionDateAsManager -- see compliance.test.ts, which holds that
    // half of the boundary.
    const viewer = await createPerson("Viewer", "vw001");
    const owner = await createPerson("Volunteer", "vol002");
    await grantPermission(viewer.id, "volunteers.view_compliance");

    expect(await canViewCertificate(viewer.id, owner.id)).toBe(true);
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

describe("canViewAllCompliance", () => {
  it("admits either half of the split and nothing else", async () => {
    const viewer = await createPerson("View Only", "vo001");
    const manager = await createPerson("Manager Only", "mo001");
    const director = await createPerson("Plain Director", "pd001");
    await grantPermission(viewer.id, "volunteers.view_compliance");
    await grantPermission(manager.id, "volunteers.manage_compliance");
    // volunteers.view is a DEPARTMENT-scoped read. It must not open the
    // clinic-wide one, or the split would hand every director the master view.
    await grantPermission(director.id, "volunteers.view");

    expect(await canViewAllCompliance(viewer.id)).toBe(true);
    // Manage implies view in code, not through the engine -- this is what lets
    // an existing Compliance Manager keep their read before the backfill runs.
    expect(await canViewAllCompliance(manager.id)).toBe(true);
    expect(await canViewAllCompliance(director.id)).toBe(false);
  });

  it("hasViewAllCompliance agrees with the async form", () => {
    expect(hasViewAllCompliance(new Set(["volunteers.view_compliance"]))).toBe(true);
    expect(hasViewAllCompliance(new Set(["volunteers.manage_compliance"]))).toBe(true);
    // The Platform Admin wildcard, which hasPermission expands.
    expect(hasViewAllCompliance(new Set(["*"]))).toBe(true);
    expect(hasViewAllCompliance(new Set(["volunteers.view"]))).toBe(false);
    expect(hasViewAllCompliance(new Set())).toBe(false);
  });
});

describe("grantPermission fixture", () => {
  it("names roles uniquely even when two grants land in the same millisecond", async () => {
    // Freezing the clock is what makes the old Date.now() fixture fail every
    // run instead of once in a while on a fast machine (audit 14, determinism).
    const frozen = vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
    try {
      const first = await createPerson("Frozen One", "frz001");
      const second = await createPerson("Frozen Two", "frz002");

      await grantPermission(first.id, "volunteers.view");
      await grantPermission(second.id, "volunteers.view");

      expect(await prisma.role.count()).toBe(2);
    } finally {
      frozen.mockRestore();
    }
  });
});
