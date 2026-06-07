/**
 * TDD tests for the department delegation helper.
 *
 * manageableDepartmentIds(personId):
 *   - Departments where the person holds an ACTIVE DIRECTOR membership in the
 *     ACTIVE term, PLUS departments those departments manage via
 *     DepartmentDelegation (one hop, no recursion), deduped.
 *   - Plain director: own department(s) only.
 *   - PCAR director: PCAR + SCTP + JCTP (delegated).
 *   - Delegation does NOT cascade: a managed department's own delegations are
 *     ignored.
 *   - No active term -> [].
 */

import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { manageableDepartmentIds } from "./departments";

// ---------------------------------------------------------------------------
// Helpers
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

describe("manageableDepartmentIds", () => {
  it("returns [] when there is no active term", async () => {
    await createTerm("ARCHIVED");
    const person = await createPerson("Dir", "d1");
    expect(await manageableDepartmentIds(person.id)).toEqual([]);
  });

  it("returns [] when the person holds no ACTIVE directorship in the active term", async () => {
    const term = await createTerm();
    const dept = await createDepartment("ITCM");
    const person = await createPerson("Vol", "v1");
    await createMembership(person.id, term.id, dept.id, "VOLUNTEER");
    expect(await manageableDepartmentIds(person.id)).toEqual([]);
  });

  it("returns only the own department for a plain director (no delegations)", async () => {
    const term = await createTerm();
    const dept = await createDepartment("ITCM");
    const person = await createPerson("Dir", "d1");
    await createMembership(person.id, term.id, dept.id, "DIRECTOR");

    const result = await manageableDepartmentIds(person.id);
    expect(result.sort()).toEqual([dept.id]);
  });

  it("ignores a REMOVED directorship", async () => {
    const term = await createTerm();
    const dept = await createDepartment("ITCM");
    const person = await createPerson("Dir", "d1");
    await createMembership(person.id, term.id, dept.id, "DIRECTOR", "REMOVED");
    expect(await manageableDepartmentIds(person.id)).toEqual([]);
  });

  it("includes delegated departments one hop out: PCAR director gets PCAR + SCTP + JCTP", async () => {
    const term = await createTerm();
    const pcar = await createDepartment("PCAR");
    const sctp = await createDepartment("SCTP");
    const jctp = await createDepartment("JCTP");
    await delegate(pcar.id, sctp.id);
    await delegate(pcar.id, jctp.id);

    const person = await createPerson("PCAR Dir", "pd1");
    await createMembership(person.id, term.id, pcar.id, "DIRECTOR");

    const result = await manageableDepartmentIds(person.id);
    expect(result.sort()).toEqual([jctp.id, pcar.id, sctp.id].sort());
  });

  it("does NOT cascade: a managed department's own delegations are ignored", async () => {
    const term = await createTerm();
    const pcar = await createDepartment("PCAR");
    const sctp = await createDepartment("SCTP");
    const deeper = await createDepartment("DEEP");
    // PCAR manages SCTP; SCTP in turn manages DEEP -- DEEP must NOT be reachable.
    await delegate(pcar.id, sctp.id);
    await delegate(sctp.id, deeper.id);

    const person = await createPerson("PCAR Dir", "pd1");
    await createMembership(person.id, term.id, pcar.id, "DIRECTOR");

    const result = await manageableDepartmentIds(person.id);
    expect(result.sort()).toEqual([pcar.id, sctp.id].sort());
    expect(result).not.toContain(deeper.id);
  });

  it("dedupes when two directed departments delegate to the same managed dept", async () => {
    const term = await createTerm();
    const pcar = await createDepartment("PCAR");
    const srhd = await createDepartment("SRHD");
    const shared = await createDepartment("SHARED");
    await delegate(pcar.id, shared.id);
    await delegate(srhd.id, shared.id);

    const person = await createPerson("Dual Dir", "dd1");
    await createMembership(person.id, term.id, pcar.id, "DIRECTOR");
    await createMembership(person.id, term.id, srhd.id, "DIRECTOR");

    const result = await manageableDepartmentIds(person.id);
    // shared appears once, both directed depts present.
    expect(result.sort()).toEqual([pcar.id, shared.id, srhd.id].sort());
    expect(result.filter((id) => id === shared.id)).toHaveLength(1);
  });
});
