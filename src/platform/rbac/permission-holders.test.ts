/**
 * "Who effectively holds permission X right now?"
 *
 * The department- and kind-scoped cases are the whole reason this exists. The
 * naive lookup this replaced walked RoleGrant -> role.assignments -> assignment.person
 * and skipped anything with a null personId, which is EVERY department-scoped
 * grant. It resolved to an empty set for the interpreting reviewers and the
 * notification it fed simply never sent, silently.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { effectivePermissionHolderIds, peopleWithPermission } from "./permission-holders";

const PERMISSION = "volunteers.verify_spanish";

let roleSeq = 0;

beforeEach(resetDb);

async function term(status: "ACTIVE" | "ARCHIVED" = "ACTIVE", code = "FA26") {
  return prisma.term.create({
    data: {
      code,
      name: `Term ${code}`,
      status,
      startDate: new Date("2026-09-01"),
      endDate: new Date("2026-12-31"),
    },
  });
}

async function department(code: string) {
  return prisma.department.create({ data: { code, name: `Dept ${code}` } });
}

async function person(name: string, status: "ACTIVE" | "OFFBOARDED" = "ACTIVE") {
  return prisma.person.create({ data: { name, status } });
}

async function roleGranting(permission: string) {
  return prisma.role.create({
    data: {
      name: `Role-${permission}-${(roleSeq += 1)}`,
      isSystem: false,
      grants: { create: [{ permission }] },
    },
  });
}

async function assign(
  roleId: string,
  target: { personId?: string; departmentId?: string; kind?: "DIRECTOR" | "VOLUNTEER"; termId?: string },
) {
  return prisma.roleAssignment.create({
    data: {
      roleId,
      personId: target.personId ?? null,
      departmentId: target.departmentId ?? null,
      kind: target.kind ?? null,
      termId: target.termId ?? null,
    },
  });
}

async function membership(
  personId: string,
  termId: string,
  departmentId: string,
  kind: "DIRECTOR" | "VOLUNTEER" = "DIRECTOR",
  status: "ACTIVE" | "REMOVED" = "ACTIVE",
) {
  return prisma.termMembership.create({
    data: { personId, termId, departmentId, kind, status },
  });
}

describe("effectivePermissionHolderIds", () => {
  it("finds a person-targeted global assignment", async () => {
    const p = await person("Direct Holder");
    const role = await roleGranting(PERMISSION);
    await assign(role.id, { personId: p.id });

    const ids = await effectivePermissionHolderIds(prisma, PERMISSION, null);
    expect([...ids]).toEqual([p.id]);
  });

  // The regression this file exists for.
  it("finds holders reached through a DEPARTMENT-scoped assignment", async () => {
    const t = await term("ACTIVE");
    const intp = await department("INTP");
    const director = await person("INTP Director");
    await membership(director.id, t.id, intp.id, "DIRECTOR");

    const role = await roleGranting(PERMISSION);
    await assign(role.id, { departmentId: intp.id, termId: t.id });

    const ids = await effectivePermissionHolderIds(prisma, PERMISSION, t);
    expect([...ids]).toEqual([director.id]);
  });

  it("finds holders reached through a KIND-scoped assignment", async () => {
    const t = await term("ACTIVE");
    const dept = await department("INTP");
    const director = await person("Any Director");
    await membership(director.id, t.id, dept.id, "DIRECTOR");

    const role = await roleGranting(PERMISSION);
    await assign(role.id, { kind: "DIRECTOR", termId: t.id });

    const ids = await effectivePermissionHolderIds(prisma, PERMISSION, t);
    expect([...ids]).toEqual([director.id]);
  });

  it("folds in the wildcard grant", async () => {
    const p = await person("Platform Admin");
    const role = await roleGranting("*");
    await assign(role.id, { personId: p.id });

    const ids = await effectivePermissionHolderIds(prisma, PERMISSION, null);
    expect([...ids]).toEqual([p.id]);
  });

  it("ignores an assignment scoped to a term that is not the active one", async () => {
    const active = await term("ACTIVE", "FA26");
    const old = await term("ARCHIVED", "SP15");
    const p = await person("Former Reviewer");
    const role = await roleGranting(PERMISSION);
    await assign(role.id, { personId: p.id, termId: old.id });

    expect((await effectivePermissionHolderIds(prisma, PERMISSION, active)).size).toBe(0);
  });

  it("ignores a department membership that is no longer ACTIVE", async () => {
    const t = await term("ACTIVE");
    const intp = await department("INTP");
    const leaver = await person("Left INTP");
    await membership(leaver.id, t.id, intp.id, "DIRECTOR", "REMOVED");

    const role = await roleGranting(PERMISSION);
    await assign(role.id, { departmentId: intp.id, termId: t.id });

    expect((await effectivePermissionHolderIds(prisma, PERMISSION, t)).size).toBe(0);
  });

  it("excludes offboarded people, who cannot sign in anyway", async () => {
    const p = await person("Offboarded Reviewer", "OFFBOARDED");
    const role = await roleGranting(PERMISSION);
    await assign(role.id, { personId: p.id });

    expect((await effectivePermissionHolderIds(prisma, PERMISSION, null)).size).toBe(0);
  });

  it("returns nobody when no role grants the permission at all", async () => {
    await person("Nobody Special");
    expect((await effectivePermissionHolderIds(prisma, PERMISSION, null)).size).toBe(0);
  });

  it("deduplicates someone reached both directly and through a department", async () => {
    const t = await term("ACTIVE");
    const intp = await department("INTP");
    const p = await person("Doubly Granted");
    await membership(p.id, t.id, intp.id, "DIRECTOR");

    const role = await roleGranting(PERMISSION);
    await assign(role.id, { personId: p.id });
    await assign(role.id, { departmentId: intp.id, termId: t.id });

    expect([...(await effectivePermissionHolderIds(prisma, PERMISSION, t))]).toEqual([p.id]);
  });

  it("honours excludeAssignmentId, which the last-admin guard depends on", async () => {
    const p = await person("Only Holder");
    const role = await roleGranting(PERMISSION);
    const assignment = await assign(role.id, { personId: p.id });

    const ids = await effectivePermissionHolderIds(prisma, PERMISSION, null, {
      excludeAssignmentId: assignment.id,
    });
    expect(ids.size).toBe(0);
  });
});

describe("peopleWithPermission", () => {
  it("returns the fields a notification needs, ordered by name", async () => {
    const b = await prisma.person.create({
      data: { name: "Zoe Reviewer", contactEmail: "zoe@example.edu" },
    });
    const a = await prisma.person.create({
      data: { name: "Alex Reviewer", contactEmail: "alex@example.edu" },
    });
    const role = await roleGranting(PERMISSION);
    await assign(role.id, { personId: a.id });
    await assign(role.id, { personId: b.id });

    const people = await peopleWithPermission(PERMISSION);
    expect(people.map((p) => p.name)).toEqual(["Alex Reviewer", "Zoe Reviewer"]);
    expect(people[0].contactEmail).toBe("alex@example.edu");
  });

  it("returns an empty list rather than throwing when nobody holds it", async () => {
    expect(await peopleWithPermission(PERMISSION)).toEqual([]);
  });
});
