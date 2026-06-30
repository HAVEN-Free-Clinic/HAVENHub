import { beforeEach, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { can } from "./engine";
import { SYSTEM_ROLES } from "./system-roles";

/**
 * Issue #65: a member whose only active membership is DIRECTOR-kind is assigned
 * department/org-wide learning courses (assignment ignores membership kind), but
 * opening one requires learning.access. The auto-attached Director system role
 * must therefore grant learning.access, or the onboarding gate locks the
 * director out of the whole app with no way to satisfy the requirement.
 *
 * The Director role is built from the real shipped SYSTEM_ROLES definition so
 * this exercises exactly what the seed/migration provision in production.
 */
async function seedDirectorOnlyMember() {
  const director = SYSTEM_ROLES.find((r) => r.name === "Director")!;
  const role = await prisma.role.create({
    data: {
      name: director.name,
      isSystem: true,
      grants: { create: director.grants.map((permission) => ({ permission })) },
    },
  });
  // Baseline Director access is provisioned as a global kind-target assignment
  // (see prisma/seed.ts and the backfill migration), not auto-attached in code.
  // Mirror that so this test exercises what production actually provisions.
  await prisma.roleAssignment.create({
    data: { roleId: role.id, kind: "DIRECTOR", termId: null },
  });
  const term = await prisma.term.create({
    data: { code: "SU26", name: "Summer 2026", status: "ACTIVE", startDate: new Date("2026-01-01"), endDate: new Date("2026-12-31") },
  });
  const dept = await prisma.department.create({ data: { code: "BVHD", name: "Behavioral Health" } });
  const person = await prisma.person.create({ data: { name: "Dana Director", status: "ACTIVE" } });
  await prisma.termMembership.create({
    data: { personId: person.id, termId: term.id, departmentId: dept.id, status: "ACTIVE", kind: "DIRECTOR" },
  });
  return person;
}

beforeEach(resetDb);

it("a director-only active member can open assigned learning courses", async () => {
  const person = await seedDirectorOnlyMember();
  expect(await can(person.id, "learning.access")).toBe(true);
});
