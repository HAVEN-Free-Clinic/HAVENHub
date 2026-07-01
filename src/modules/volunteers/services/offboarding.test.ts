/**
 * TDD tests for the volunteers offboarding service.
 *
 * flagForOffboarding(actorPersonId, personId, note?):
 *   - Director flags own-dept member; flag row created; audit row exists.
 *   - Delegation edge: PCAR director managing dept B via DepartmentDelegation can flag a member of B.
 *   - Director cannot flag a member of an unrelated department (OffboardForbiddenError).
 *   - Holder of volunteers.manage_offboarding (via role grant) can flag anyone.
 *   - Double-flag returns the existing row; only ONE audit entry for offboard.flag.
 *   - No active term -> OffboardForbiddenError.
 *
 * unflag(actorPersonId, personId):
 *   - Deletes the flag; second unflag -> OffboardNotFoundError.
 *
 * executeOffboard(actorPersonId, personId):
 *   - Without permission -> OffboardForbiddenError.
 *   - Person had ACTIVE memberships in TWO terms + a flag; after: Person.status OFFBOARDED,
 *     both memberships REMOVED, zero flags, audit person.offboard present.
 *
 * offboardingView(viewerPersonId):
 *   - Returns director's departments with members and flags.
 *   - flagged is null without the permission; populated with it.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import * as people from "@/platform/people";
import {
  flagForOffboarding,
  unflag,
  executeOffboard,
  offboardingView,
  OffboardForbiddenError,
  OffboardNotFoundError,
} from "./offboarding";

// ---------------------------------------------------------------------------
// Helpers (mirror style from compliance.test.ts)
// ---------------------------------------------------------------------------

async function createPerson(name: string, netId?: string) {
  return prisma.person.create({ data: { name, netId } });
}

async function createTerm(
  status: "ACTIVE" | "ARCHIVED" | "PLANNING" = "ACTIVE",
  code = "SU26"
) {
  return prisma.term.create({
    data: {
      code,
      name: `Term ${code}`,
      startDate: new Date("2026-05-01"),
      endDate: new Date("2026-09-26"),
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
    data: {
      name: `Role-${permission}-${Date.now()}-${Math.random()}`,
      isSystem: false,
      grants: { create: [{ permission }] },
    },
  });
  await prisma.roleAssignment.create({ data: { roleId: role.id, personId, termId: null } });
}

async function delegate(managerDepartmentId: string, managedDepartmentId: string) {
  return prisma.departmentDelegation.create({
    data: { managerDepartmentId, managedDepartmentId },
  });
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(resetDb);

// ---------------------------------------------------------------------------
// flagForOffboarding
// ---------------------------------------------------------------------------

describe("flagForOffboarding", () => {
  it("director flags own-dept member; flag row created; audit row exists", async () => {
    const term = await createTerm();
    const dept = await createDepartment("ITCM");
    const actor = await createPerson("Director", "dir001");
    const target = await createPerson("Volunteer", "vol001");

    await createMembership(actor.id, term.id, dept.id, "DIRECTOR");
    await createMembership(target.id, term.id, dept.id, "VOLUNTEER");

    const flag = await flagForOffboarding(actor.id, target.id, "Graduating soon");

    expect(flag.personId).toBe(target.id);
    expect(flag.termId).toBe(term.id);
    expect(flag.flaggedById).toBe(actor.id);
    expect(flag.note).toBe("Graduating soon");

    const auditRow = await prisma.auditLog.findFirst({
      where: { action: "offboard.flag", entityId: flag.id },
    });
    expect(auditRow).not.toBeNull();
    expect(auditRow?.actorPersonId).toBe(actor.id);
    const after = auditRow?.after as Record<string, unknown>;
    expect(after.note).toBe("Graduating soon");
  });

  it("delegation edge: PCAR director can flag a member of delegated dept B", async () => {
    const term = await createTerm();
    const pcar = await createDepartment("PCAR");
    const sctp = await createDepartment("SCTP");
    await delegate(pcar.id, sctp.id);

    const actor = await createPerson("PCAR Dir", "pcd01");
    const target = await createPerson("SCTP Vol", "sv01");

    await createMembership(actor.id, term.id, pcar.id, "DIRECTOR");
    await createMembership(target.id, term.id, sctp.id, "VOLUNTEER");

    const flag = await flagForOffboarding(actor.id, target.id);

    expect(flag.personId).toBe(target.id);
  });

  it("director cannot flag a member of an unrelated department", async () => {
    const term = await createTerm();
    const deptA = await createDepartment("ITCM");
    const deptB = await createDepartment("SRR");

    const actor = await createPerson("DirA", "dira01");
    const target = await createPerson("VolB", "volb01");

    await createMembership(actor.id, term.id, deptA.id, "DIRECTOR");
    await createMembership(target.id, term.id, deptB.id, "VOLUNTEER");

    await expect(flagForOffboarding(actor.id, target.id)).rejects.toBeInstanceOf(
      OffboardForbiddenError
    );
  });

  it("holder of volunteers.manage_offboarding can flag anyone", async () => {
    const term = await createTerm();
    const dept = await createDepartment("SRR");
    const actor = await createPerson("Manager", "mgr001");
    const target = await createPerson("Anyone", "any001");

    await grantPermission(actor.id, "volunteers.manage_offboarding");
    await createMembership(target.id, term.id, dept.id, "VOLUNTEER");

    const flag = await flagForOffboarding(actor.id, target.id);
    expect(flag.personId).toBe(target.id);
  });

  it("double-flag returns the existing row; only ONE audit entry for offboard.flag", async () => {
    const term = await createTerm();
    const dept = await createDepartment("ITCM");
    const actor = await createPerson("Director", "dir001");
    const target = await createPerson("Volunteer", "vol001");

    await createMembership(actor.id, term.id, dept.id, "DIRECTOR");
    await createMembership(target.id, term.id, dept.id, "VOLUNTEER");

    const flag1 = await flagForOffboarding(actor.id, target.id, "First flag");
    const flag2 = await flagForOffboarding(actor.id, target.id, "Second flag");

    // Same row returned.
    expect(flag2.id).toBe(flag1.id);

    // Only one audit row for offboard.flag for this entityId.
    const auditRows = await prisma.auditLog.findMany({
      where: { action: "offboard.flag", entityId: flag1.id },
    });
    expect(auditRows).toHaveLength(1);
  });

  it("no active term -> OffboardForbiddenError", async () => {
    await createTerm("ARCHIVED");
    const actor = await createPerson("Director", "dir001");
    const target = await createPerson("Volunteer", "vol001");

    await expect(flagForOffboarding(actor.id, target.id)).rejects.toBeInstanceOf(
      OffboardForbiddenError
    );
  });
});

// ---------------------------------------------------------------------------
// unflag
// ---------------------------------------------------------------------------

describe("unflag", () => {
  it("deletes the flag and second unflag throws OffboardNotFoundError", async () => {
    const term = await createTerm();
    const dept = await createDepartment("ITCM");
    const actor = await createPerson("Director", "dir001");
    const target = await createPerson("Volunteer", "vol001");

    await createMembership(actor.id, term.id, dept.id, "DIRECTOR");
    await createMembership(target.id, term.id, dept.id, "VOLUNTEER");

    await flagForOffboarding(actor.id, target.id);

    // First unflag: succeeds.
    await expect(unflag(actor.id, target.id)).resolves.toBeUndefined();

    // Verify flag deleted.
    const remaining = await prisma.offboardFlag.findUnique({
      where: { personId_termId: { personId: target.id, termId: term.id } },
    });
    expect(remaining).toBeNull();

    // Audit row for unflag written.
    const auditRow = await prisma.auditLog.findFirst({
      where: { action: "offboard.unflag" },
    });
    expect(auditRow).not.toBeNull();

    // Second unflag: OffboardNotFoundError.
    await expect(unflag(actor.id, target.id)).rejects.toBeInstanceOf(OffboardNotFoundError);
  });
});

// ---------------------------------------------------------------------------
// executeOffboard
// ---------------------------------------------------------------------------

describe("executeOffboard", () => {
  it("without permission -> OffboardForbiddenError", async () => {
    const actor = await createPerson("NoPermission", "np001");
    const target = await createPerson("Target", "tgt001");

    await expect(executeOffboard(actor.id, target.id)).rejects.toBeInstanceOf(
      OffboardForbiddenError
    );
  });

  it("person had ACTIVE memberships in TWO terms + a flag; after: status OFFBOARDED, memberships REMOVED, zero flags, audit present", async () => {
    // Two terms.
    const term1 = await createTerm("ACTIVE", "SU26");
    const term2 = await createTerm("ACTIVE", "FA26");
    const dept = await createDepartment("ITCM");

    const actor = await createPerson("Executor", "exec001");
    const target = await createPerson("Target", "tgt001");

    await grantPermission(actor.id, "volunteers.manage_offboarding");

    // Two ACTIVE memberships across the two terms.
    await createMembership(target.id, term1.id, dept.id, "VOLUNTEER");
    await createMembership(target.id, term2.id, dept.id, "VOLUNTEER");

    // Create a flag in one of the terms.
    await prisma.offboardFlag.create({
      data: { personId: target.id, termId: term1.id, flaggedById: actor.id },
    });

    await executeOffboard(actor.id, target.id);

    // Person.status is OFFBOARDED.
    const person = await prisma.person.findUniqueOrThrow({ where: { id: target.id } });
    expect(person.status).toBe("OFFBOARDED");

    // Both memberships are REMOVED.
    const memberships = await prisma.termMembership.findMany({
      where: { personId: target.id },
    });
    expect(memberships).toHaveLength(2);
    for (const m of memberships) {
      expect(m.status).toBe("REMOVED");
    }

    // No flags remain.
    const flags = await prisma.offboardFlag.findMany({ where: { personId: target.id } });
    expect(flags).toHaveLength(0);

    // Audit row for offboard.execute present with removedMemberships count.
    const auditRow = await prisma.auditLog.findFirst({
      where: { action: "offboard.execute", entityId: target.id },
    });
    expect(auditRow).not.toBeNull();
    const after = auditRow?.after as Record<string, unknown>;
    expect(after.removedMemberships).toBe(2);

    // setPersonStatusField also writes person.offboard for the status change.
    const statusAudit = await prisma.auditLog.findFirst({
      where: { action: "person.offboard", entityId: target.id },
    });
    expect(statusAudit).not.toBeNull();
  });

  it("offboarding a person with an epicId cancels open grants and queues a DEACTIVATE", async () => {
    const term = await createTerm("ACTIVE");
    const dept = await createDepartment("EPIC");
    const actor = await createPerson("Exec");
    await grantPermission(actor.id, "volunteers.manage_offboarding");

    const person = await prisma.person.create({ data: { name: "Leaver", epicId: "E999", status: "ACTIVE" } });
    await createMembership(person.id, term.id, dept.id, "VOLUNTEER", "ACTIVE");
    const openReq = await prisma.epicRequest.create({
      data: { personId: person.id, kind: "MODIFY", status: "PENDING", requestedById: actor.id },
    });

    await executeOffboard(actor.id, person.id);

    const updated = await prisma.person.findUnique({ where: { id: person.id } });
    expect(updated?.status).toBe("OFFBOARDED");

    const grant = await prisma.epicRequest.findUnique({ where: { id: openReq.id } });
    expect(grant?.status).toBe("CANCELLED");

    const deact = await prisma.epicRequest.findMany({ where: { personId: person.id, kind: "DEACTIVATE" } });
    expect(deact).toHaveLength(1);
    expect(deact[0].status).toBe("PENDING");
  });

  it("if the status flip fails, the person stays flagged + on roster (recoverable, no invisible half-state)", async () => {
    const term = await createTerm("ACTIVE");
    const dept = await createDepartment("HALF");
    const actor = await createPerson("Exec", "exec-half");
    await grantPermission(actor.id, "volunteers.manage_offboarding");

    const target = await createPerson("Target", "tgt-half");
    await createMembership(target.id, term.id, dept.id, "VOLUNTEER", "ACTIVE");
    await prisma.offboardFlag.create({
      data: { personId: target.id, termId: term.id, flaggedById: actor.id },
    });

    // Simulate a DB crash during the status flip (the non-atomic second step).
    const spy = vi
      .spyOn(people, "setPersonStatusField")
      .mockRejectedValueOnce(new Error("simulated crash during status flip"));

    await expect(executeOffboard(actor.id, target.id)).rejects.toThrow();
    spy.mockRestore();

    // The destructive cleanup must not have run ahead of the status flip:
    // the person remains ACTIVE, still on the roster, and STILL FLAGGED, so they
    // stay visible in the offboarding queue and the executor can simply retry.
    const person = await prisma.person.findUniqueOrThrow({ where: { id: target.id } });
    expect(person.status).toBe("ACTIVE");

    const memberships = await prisma.termMembership.findMany({ where: { personId: target.id } });
    expect(memberships.every((m) => m.status === "ACTIVE")).toBe(true);

    const flags = await prisma.offboardFlag.findMany({ where: { personId: target.id } });
    expect(flags).toHaveLength(1);

    // Retry now succeeds and converges to a fully-offboarded state.
    await executeOffboard(actor.id, target.id);
    const after = await prisma.person.findUniqueOrThrow({ where: { id: target.id } });
    expect(after.status).toBe("OFFBOARDED");
    const flagsAfter = await prisma.offboardFlag.findMany({ where: { personId: target.id } });
    expect(flagsAfter).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// offboardingView
// ---------------------------------------------------------------------------

describe("offboardingView", () => {
  it("returns director's departments with members and their flags", async () => {
    const term = await createTerm();
    const dept = await createDepartment("ITCM");
    const director = await createPerson("Director", "dir001");
    const vol = await createPerson("Volunteer", "vol001");

    await createMembership(director.id, term.id, dept.id, "DIRECTOR");
    await createMembership(vol.id, term.id, dept.id, "VOLUNTEER");

    // Flag the volunteer.
    await prisma.offboardFlag.create({
      data: { personId: vol.id, termId: term.id, flaggedById: director.id },
    });

    const result = await offboardingView(director.id);

    expect(result.departments).toHaveLength(1);
    expect(result.departments[0].department.code).toBe("ITCM");

    const members = result.departments[0].members;
    expect(members).toHaveLength(2);

    const volMember = members.find((m) => m.person.id === vol.id);
    expect(volMember?.flag).not.toBeNull();
    expect(volMember?.flag?.flaggedById).toBe(director.id);

    const dirMember = members.find((m) => m.person.id === director.id);
    expect(dirMember?.flag).toBeNull();
  });

  it("flagged is null without manage_offboarding permission", async () => {
    const term = await createTerm();
    const dept = await createDepartment("ITCM");
    const director = await createPerson("Director", "dir001");
    const vol = await createPerson("Volunteer", "vol001");

    await createMembership(director.id, term.id, dept.id, "DIRECTOR");
    await createMembership(vol.id, term.id, dept.id, "VOLUNTEER");

    // Create an actual flag row so we prove null means "hidden", not "empty".
    await prisma.offboardFlag.create({
      data: { personId: vol.id, termId: term.id, flaggedById: director.id },
    });

    const result = await offboardingView(director.id);
    expect(result.flagged).toBeNull();
  });

  it("flagged is populated when viewer has manage_offboarding", async () => {
    const term = await createTerm();
    const dept = await createDepartment("ITCM");
    const executor = await createPerson("Executor", "exec001");
    const vol = await createPerson("Volunteer", "vol001");
    const flagger = await createPerson("Flagger", "flg001");

    await grantPermission(executor.id, "volunteers.manage_offboarding");
    await createMembership(vol.id, term.id, dept.id, "VOLUNTEER");

    // A flag exists in the active term.
    await prisma.offboardFlag.create({
      data: { personId: vol.id, termId: term.id, flaggedById: flagger.id, note: "ready to exit" },
    });

    const result = await offboardingView(executor.id);

    expect(result.flagged).not.toBeNull();
    expect(result.flagged).toHaveLength(1);

    const row = result.flagged![0];
    expect(row.person.id).toBe(vol.id);
    expect(row.flaggedByName).toBe("Flagger");
    expect(row.departmentNames).toContain("ITCM Dept");
    expect(row.flag.note).toBe("ready to exit");
  });

  it("no active term returns empty departments and null flagged", async () => {
    await createTerm("ARCHIVED");
    const person = await createPerson("Person", "p001");

    const result = await offboardingView(person.id);
    expect(result.departments).toHaveLength(0);
    expect(result.flagged).toBeNull();
  });
});
