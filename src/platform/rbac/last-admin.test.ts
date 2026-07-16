/**
 * Last-admin offboard guard tests (audit M7).
 *
 * assertNotLastActiveAdmin(personId) throws LastAdminError when the person is
 * the last ACTIVE holder of an admin-conferring grant ("*" or "admin.access"),
 * so offboarding them cannot lock everyone out of the admin module. It is a
 * no-op for non-admins and when another active admin remains, and it counts
 * only ACTIVE people and only engine-honored (global or active-term) assignments.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import {
  assertNotLastActiveAdmin,
  assertNotLastActiveAdminTx,
  assertActiveAdminRemainsTx,
  isEffectiveActiveAdmin,
  LastAdminError,
} from "./last-admin";

async function seedPerson(name: string, status: "ACTIVE" | "OFFBOARDED" = "ACTIVE") {
  return prisma.person.create({ data: { name, status } });
}

async function seedDepartment(code: string) {
  return prisma.department.create({ data: { code, name: `Dept ${code}` } });
}

async function seedTerm(code: string, status: "ACTIVE" | "PLANNING" | "ARCHIVED" = "ACTIVE") {
  return prisma.term.create({
    data: {
      code,
      name: `Term ${code}`,
      startDate: new Date("2026-01-01T12:00:00Z"),
      endDate: new Date("2026-04-30T12:00:00Z"),
      status,
    },
  });
}

async function seedAdminRole(permission: "*" | "admin.access" = "*", name = "Platform Admin") {
  return prisma.role.create({
    data: { name, isSystem: true, grants: { create: [{ permission }] } },
  });
}

describe("assertNotLastActiveAdmin", () => {
  beforeEach(resetDb);

  it("throws LastAdminError when offboarding the sole active admin", async () => {
    const role = await seedAdminRole("*");
    const admin = await seedPerson("Sole Admin");
    await prisma.roleAssignment.create({ data: { roleId: role.id, personId: admin.id } });

    await expect(assertNotLastActiveAdmin(admin.id)).rejects.toBeInstanceOf(LastAdminError);
  });

  it("does not throw when another active admin remains", async () => {
    const role = await seedAdminRole("admin.access");
    const a1 = await seedPerson("Admin 1");
    const a2 = await seedPerson("Admin 2");
    await prisma.roleAssignment.create({ data: { roleId: role.id, personId: a1.id } });
    await prisma.roleAssignment.create({ data: { roleId: role.id, personId: a2.id } });

    await expect(assertNotLastActiveAdmin(a1.id)).resolves.toBeUndefined();
  });

  it("does not throw when the person is not an admin", async () => {
    const role = await seedAdminRole("*");
    const admin = await seedPerson("The Admin");
    const nonAdmin = await seedPerson("Regular Person");
    await prisma.roleAssignment.create({ data: { roleId: role.id, personId: admin.id } });

    await expect(assertNotLastActiveAdmin(nonAdmin.id)).resolves.toBeUndefined();
  });

  it("counts only ACTIVE people: throws when the only other admin is already offboarded", async () => {
    const role = await seedAdminRole("*");
    const active = await seedPerson("Active Admin");
    const offboarded = await seedPerson("Gone Admin", "OFFBOARDED");
    await prisma.roleAssignment.create({ data: { roleId: role.id, personId: active.id } });
    await prisma.roleAssignment.create({ data: { roleId: role.id, personId: offboarded.id } });

    await expect(assertNotLastActiveAdmin(active.id)).rejects.toBeInstanceOf(LastAdminError);
  });

  it("counts only engine-honored assignments: an archived-term admin grant does not save the last live admin", async () => {
    const role = await seedAdminRole("*");
    await seedTerm("SU26", "ACTIVE");
    const archivedTerm = await seedTerm("FA25", "ARCHIVED");
    const liveAdmin = await seedPerson("Live Admin");
    const staleAdmin = await seedPerson("Stale Admin");
    // Live global admin + an inert admin scoped to an archived term.
    await prisma.roleAssignment.create({ data: { roleId: role.id, personId: liveAdmin.id } });
    await prisma.roleAssignment.create({
      data: { roleId: role.id, personId: staleAdmin.id, termId: archivedTerm.id },
    });

    await expect(assertNotLastActiveAdmin(liveAdmin.id)).rejects.toBeInstanceOf(LastAdminError);
  });

  it("resolves department-scoped admin grants through active-term memberships", async () => {
    const activeTerm = await seedTerm("SU26", "ACTIVE");
    const dept = await seedDepartment("ADMINDEPT");
    const role = await prisma.role.create({
      data: { name: "Dept Admin", grants: { create: [{ permission: "admin.access" }] } },
    });
    await prisma.roleAssignment.create({
      data: { roleId: role.id, departmentId: dept.id, termId: activeTerm.id },
    });
    const member = await seedPerson("Dept Member");
    await prisma.termMembership.create({
      data: {
        personId: member.id,
        termId: activeTerm.id,
        departmentId: dept.id,
        kind: "DIRECTOR",
        status: "ACTIVE",
      },
    });

    // The department member is the sole active admin via the dept-scoped grant.
    await expect(assertNotLastActiveAdmin(member.id)).rejects.toBeInstanceOf(LastAdminError);
  });

  it("does not throw when there are no admin-conferring grants at all", async () => {
    const person = await seedPerson("Nobody Special");
    await expect(assertNotLastActiveAdmin(person.id)).resolves.toBeUndefined();
  });
});

/**
 * Transactional twin (audit M9/L8): the same invariant recomputed on a
 * transaction client so the offboard check and the Person.status flip commit
 * atomically. Behaviourally mirrors the standalone form.
 */
describe("assertNotLastActiveAdminTx", () => {
  beforeEach(resetDb);

  it("throws LastAdminError inside a tx when offboarding the sole active admin", async () => {
    const role = await seedAdminRole("*");
    const admin = await seedPerson("Sole Admin");
    await prisma.roleAssignment.create({ data: { roleId: role.id, personId: admin.id } });

    await expect(
      prisma.$transaction((tx) => assertNotLastActiveAdminTx(tx, admin.id))
    ).rejects.toBeInstanceOf(LastAdminError);
  });

  it("resolves inside a tx when another active admin remains", async () => {
    const role = await seedAdminRole("admin.access");
    const a1 = await seedPerson("Admin 1");
    const a2 = await seedPerson("Admin 2");
    await prisma.roleAssignment.create({ data: { roleId: role.id, personId: a1.id } });
    await prisma.roleAssignment.create({ data: { roleId: role.id, personId: a2.id } });

    await expect(
      prisma.$transaction((tx) => assertNotLastActiveAdminTx(tx, a1.id))
    ).resolves.toBeUndefined();
  });

  it("is a no-op inside a tx for a non-admin person", async () => {
    const role = await seedAdminRole("*");
    const admin = await seedPerson("The Admin");
    const nonAdmin = await seedPerson("Regular Person");
    await prisma.roleAssignment.create({ data: { roleId: role.id, personId: admin.id } });

    await expect(
      prisma.$transaction((tx) => assertNotLastActiveAdminTx(tx, nonAdmin.id))
    ).resolves.toBeUndefined();
  });

  it("counts only ACTIVE people inside a tx: throws when the only other admin is offboarded", async () => {
    const role = await seedAdminRole("*");
    const active = await seedPerson("Active Admin");
    const offboarded = await seedPerson("Gone Admin", "OFFBOARDED");
    await prisma.roleAssignment.create({ data: { roleId: role.id, personId: active.id } });
    await prisma.roleAssignment.create({ data: { roleId: role.id, personId: offboarded.id } });

    await expect(
      prisma.$transaction((tx) => assertNotLastActiveAdminTx(tx, active.id))
    ).rejects.toBeInstanceOf(LastAdminError);
  });
});

/**
 * isEffectiveActiveAdmin is the fast pre-check the roster guards use to decide
 * whether the (Serializable) last-admin recomputation is needed at all.
 */
describe("isEffectiveActiveAdmin", () => {
  beforeEach(resetDb);

  it("is true for an active admin and false for a non-admin", async () => {
    const role = await seedAdminRole("*");
    const admin = await seedPerson("Admin");
    const other = await seedPerson("Other");
    await prisma.roleAssignment.create({ data: { roleId: role.id, personId: admin.id } });

    expect(await isEffectiveActiveAdmin(admin.id)).toBe(true);
    expect(await isEffectiveActiveAdmin(other.id)).toBe(false);
  });

  it("is false for an offboarded holder of an admin assignment", async () => {
    const role = await seedAdminRole("*");
    const gone = await seedPerson("Gone Admin", "OFFBOARDED");
    await prisma.roleAssignment.create({ data: { roleId: role.id, personId: gone.id } });

    expect(await isEffectiveActiveAdmin(gone.id)).toBe(false);
  });

  it("is true for a member who holds admin via a department-scoped grant", async () => {
    const activeTerm = await seedTerm("SU26", "ACTIVE");
    const dept = await seedDepartment("ADMINDEPT");
    const role = await prisma.role.create({
      data: { name: "Dept Admin", grants: { create: [{ permission: "admin.access" }] } },
    });
    await prisma.roleAssignment.create({
      data: { roleId: role.id, departmentId: dept.id, termId: activeTerm.id },
    });
    const member = await seedPerson("Dept Member");
    await prisma.termMembership.create({
      data: {
        personId: member.id,
        termId: activeTerm.id,
        departmentId: dept.id,
        kind: "DIRECTOR",
        status: "ACTIVE",
      },
    });

    expect(await isEffectiveActiveAdmin(member.id)).toBe(true);
  });
});

/**
 * assertActiveAdminRemainsTx is the post-mutation invariant the roster guards
 * run inside their Serializable transaction: refuse when no effective ACTIVE
 * admin remains.
 */
describe("assertActiveAdminRemainsTx", () => {
  beforeEach(resetDb);

  it("throws when no effective active admin exists (only an offboarded holder)", async () => {
    const role = await seedAdminRole("*");
    const gone = await seedPerson("Gone Admin", "OFFBOARDED");
    await prisma.roleAssignment.create({ data: { roleId: role.id, personId: gone.id } });

    await expect(
      prisma.$transaction((tx) => assertActiveAdminRemainsTx(tx))
    ).rejects.toBeInstanceOf(LastAdminError);
  });

  it("resolves when an effective active admin exists", async () => {
    const role = await seedAdminRole("*");
    const admin = await seedPerson("Live Admin");
    await prisma.roleAssignment.create({ data: { roleId: role.id, personId: admin.id } });

    await expect(
      prisma.$transaction((tx) => assertActiveAdminRemainsTx(tx))
    ).resolves.toBeUndefined();
  });
});
