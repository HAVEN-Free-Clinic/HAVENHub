import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";

/**
 * These constraints live in raw SQL (Prisma cannot model them) and were once
 * silently dropped by a generated migration. These tests exist so that can
 * never happen again without CI noticing.
 */
describe("db-level schema guards", () => {
  beforeEach(resetDb);

  async function fixture() {
    const role = await prisma.role.create({ data: { name: "R" } });
    const person = await prisma.person.create({ data: { name: "P" } });
    return { role, person };
  }

  it("rejects duplicate role assignments including NULL termId (unique_grant)", async () => {
    const { role, person } = await fixture();
    await prisma.roleAssignment.create({ data: { roleId: role.id, personId: person.id, termId: null } });
    await expect(
      prisma.roleAssignment.create({ data: { roleId: role.id, personId: person.id, termId: null } })
    ).rejects.toThrow();
  });

  it("rejects assignments violating the person/department XOR", async () => {
    const { role } = await fixture();
    await expect(
      prisma.roleAssignment.create({ data: { roleId: role.id } }) // neither target set
    ).rejects.toThrow();
  });

  it("rejects case-variant duplicate person emails (ci-unique)", async () => {
    await prisma.person.create({ data: { name: "A", contactEmail: "x@yale.edu" } });
    await expect(
      prisma.person.create({ data: { name: "B", contactEmail: "X@YALE.EDU" } })
    ).rejects.toThrow();
  });

  it("rejects assignments with two targets set (3-way XOR)", async () => {
    const { role, person } = await fixture();
    const dept = await prisma.department.create({ data: { code: "XOR", name: "X" } });
    await expect(
      prisma.roleAssignment.create({
        data: { roleId: role.id, personId: person.id, departmentId: dept.id },
      })
    ).rejects.toThrow();
  });

  it("rejects assignments with a kind and a person target both set (3-way XOR)", async () => {
    const { role, person } = await fixture();
    await expect(
      prisma.roleAssignment.create({
        data: { roleId: role.id, personId: person.id, kind: "VOLUNTEER" },
      })
    ).rejects.toThrow();
  });

  it("rejects duplicate kind-target assignments (unique_grant spans kind)", async () => {
    const { role } = await fixture();
    await prisma.roleAssignment.create({ data: { roleId: role.id, kind: "VOLUNTEER", termId: null } });
    await expect(
      prisma.roleAssignment.create({ data: { roleId: role.id, kind: "VOLUNTEER", termId: null } })
    ).rejects.toThrow();
  });
});
