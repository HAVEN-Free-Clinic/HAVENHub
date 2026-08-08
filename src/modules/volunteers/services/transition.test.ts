/**
 * Tests for the term transition report.
 *
 * Bucket rules under test:
 *   RETURNING      - holds an ACTIVE membership in the next (PLANNING) term.
 *   PENDING        - no next-term membership, but a SUBMITTED application exists
 *                    in a cycle attached to the next term.
 *   NOT_RETURNING  - neither.
 *
 * The emailLower fallback case is the important one: an anonymous NEW applicant
 * has no Applicant.applicantPersonId, and misclassifying that person as
 * NOT_RETURNING would feed them into a default-checked bulk flag.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { transitionView } from "./transition";

async function createPerson(name: string, netId?: string, contactEmail?: string) {
  return prisma.person.create({ data: { name, netId, contactEmail } });
}

async function createTerm(
  status: "ACTIVE" | "ARCHIVED" | "PLANNING",
  code: string,
  startDate: string
) {
  return prisma.term.create({
    data: {
      code,
      name: `Term ${code}`,
      startDate: new Date(startDate),
      endDate: new Date(startDate),
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
  kind: "VOLUNTEER" | "DIRECTOR" = "VOLUNTEER",
  status: "ACTIVE" | "REMOVED" = "ACTIVE"
) {
  return prisma.termMembership.create({
    data: { personId, termId, departmentId, kind, status },
  });
}

async function grantPermission(personId: string, permission: string) {
  const role = await prisma.role.create({
    data: {
      name: `Role-${permission}-${personId}`,
      isSystem: false,
      grants: { create: [{ permission }] },
    },
  });
  await prisma.roleAssignment.create({ data: { roleId: role.id, personId, termId: null } });
}

/**
 * A cycle attached to `termId` with one application. `applicantPersonId` links
 * the applicant to a Person (the signed-in case); pass null to simulate an
 * anonymous applicant, which is what the emailLower fallback has to catch.
 */
async function createApplication(opts: {
  termId: string;
  email: string;
  applicantPersonId: string | null;
  status: "DRAFT" | "SUBMITTED";
  slug: string;
  /** RecruitmentCycle.createdById is required with a Restrict relation to Person. */
  createdById: string;
}) {
  const cycle = await prisma.recruitmentCycle.create({
    data: {
      track: "VOLUNTEER",
      termId: opts.termId,
      title: `Cycle ${opts.slug}`,
      publicSlug: opts.slug,
      departments: [],
      createdById: opts.createdById,
    },
  });
  const applicant = await prisma.applicant.create({
    data: {
      cycleId: cycle.id,
      applicantPersonId: opts.applicantPersonId,
      firstName: "A",
      lastName: "B",
      email: opts.email,
      emailLower: opts.email.toLowerCase(),
    },
  });
  return prisma.application.create({
    data: {
      cycleId: cycle.id,
      applicantId: applicant.id,
      answers: {},
      status: opts.status,
    },
  });
}

beforeEach(resetDb);

describe("transitionView", () => {
  it("returns nextTerm null and no rows when no term is in planning", async () => {
    const term = await createTerm("ACTIVE", "FA25", "2025-08-01");
    const dept = await createDepartment("ITCM");
    const viewer = await createPerson("Exec", "exec01");
    await grantPermission(viewer.id, "volunteers.manage_offboarding");
    const member = await createPerson("Member", "mem01");
    await createMembership(member.id, term.id, dept.id);

    const view = await transitionView(viewer.id);

    expect(view.activeTerm?.code).toBe("FA25");
    expect(view.nextTerm).toBeNull();
    expect(view.rows).toEqual([]);
  });

  it("buckets a person with a next-term membership as RETURNING", async () => {
    const active = await createTerm("ACTIVE", "FA25", "2025-08-01");
    const next = await createTerm("PLANNING", "SP26", "2026-01-01");
    const dept = await createDepartment("ITCM");
    const viewer = await createPerson("Exec", "exec01");
    await grantPermission(viewer.id, "volunteers.manage_offboarding");
    const member = await createPerson("Returner", "ret01");
    await createMembership(member.id, active.id, dept.id);
    await createMembership(member.id, next.id, dept.id);

    const view = await transitionView(viewer.id);

    const row = view.rows.find((r) => r.personId === member.id);
    expect(row?.bucket).toBe("RETURNING");
    expect(row?.selectable).toBe(false);
  });

  it("buckets a submitted application linked by applicantPersonId as PENDING", async () => {
    const active = await createTerm("ACTIVE", "FA25", "2025-08-01");
    const next = await createTerm("PLANNING", "SP26", "2026-01-01");
    const dept = await createDepartment("ITCM");
    const viewer = await createPerson("Exec", "exec01");
    await grantPermission(viewer.id, "volunteers.manage_offboarding");
    const member = await createPerson("Applicant", "app01", "app01@yale.edu");
    await createMembership(member.id, active.id, dept.id);
    await createApplication({
      termId: next.id,
      email: "app01@yale.edu",
      applicantPersonId: member.id,
      status: "SUBMITTED",
      slug: "linked",
      createdById: viewer.id,
    });

    const view = await transitionView(viewer.id);

    const row = view.rows.find((r) => r.personId === member.id);
    expect(row?.bucket).toBe("PENDING");
    expect(row?.selectable).toBe(true);
  });

  it("buckets a submitted application matched only by emailLower as PENDING", async () => {
    const active = await createTerm("ACTIVE", "FA25", "2025-08-01");
    const next = await createTerm("PLANNING", "SP26", "2026-01-01");
    const dept = await createDepartment("ITCM");
    const viewer = await createPerson("Exec", "exec01");
    await grantPermission(viewer.id, "volunteers.manage_offboarding");
    // netId drives the yaleEmailForNetId fallback; the applicant row carries no
    // applicantPersonId, which is the anonymous-NEW-applicant case.
    const member = await createPerson("Anon", "anon01");
    await createMembership(member.id, active.id, dept.id);
    await createApplication({
      termId: next.id,
      email: "Anon01@Yale.edu",
      applicantPersonId: null,
      status: "SUBMITTED",
      slug: "anon",
      createdById: viewer.id,
    });

    const view = await transitionView(viewer.id);

    const row = view.rows.find((r) => r.personId === member.id);
    expect(row?.bucket).toBe("PENDING");
  });

  it("buckets a draft application as NOT_RETURNING and sets the draft chip", async () => {
    const active = await createTerm("ACTIVE", "FA25", "2025-08-01");
    const next = await createTerm("PLANNING", "SP26", "2026-01-01");
    const dept = await createDepartment("ITCM");
    const viewer = await createPerson("Exec", "exec01");
    await grantPermission(viewer.id, "volunteers.manage_offboarding");
    const member = await createPerson("Drafter", "drf01", "drf01@yale.edu");
    await createMembership(member.id, active.id, dept.id);
    await createApplication({
      termId: next.id,
      email: "drf01@yale.edu",
      applicantPersonId: member.id,
      status: "DRAFT",
      slug: "draft",
      createdById: viewer.id,
    });

    const view = await transitionView(viewer.id);

    const row = view.rows.find((r) => r.personId === member.id);
    expect(row?.bucket).toBe("NOT_RETURNING");
    expect(row?.hasDraftApplication).toBe(true);
  });

  it("buckets a person with neither signal as NOT_RETURNING", async () => {
    const active = await createTerm("ACTIVE", "FA25", "2025-08-01");
    await createTerm("PLANNING", "SP26", "2026-01-01");
    const dept = await createDepartment("ITCM");
    const viewer = await createPerson("Exec", "exec01");
    await grantPermission(viewer.id, "volunteers.manage_offboarding");
    const member = await createPerson("Leaver", "lev01");
    await createMembership(member.id, active.id, dept.id, "DIRECTOR");

    const view = await transitionView(viewer.id);

    const row = view.rows.find((r) => r.personId === member.id);
    expect(row?.bucket).toBe("NOT_RETURNING");
    expect(row?.role).toBe("DIRECTOR");
    expect(row?.selectable).toBe(true);
    expect(row?.departments.map((d) => d.code)).toEqual(["ITCM"]);
  });

  it("marks an existing flag, and a self-raised flag as selfWithdrew", async () => {
    const active = await createTerm("ACTIVE", "FA25", "2025-08-01");
    await createTerm("PLANNING", "SP26", "2026-01-01");
    const dept = await createDepartment("ITCM");
    const viewer = await createPerson("Exec", "exec01");
    await grantPermission(viewer.id, "volunteers.manage_offboarding");
    const selfFlagged = await createPerson("Self", "self01");
    const otherFlagged = await createPerson("Other", "oth01");
    await createMembership(selfFlagged.id, active.id, dept.id);
    await createMembership(otherFlagged.id, active.id, dept.id);
    await prisma.offboardFlag.create({
      data: { personId: selfFlagged.id, termId: active.id, flaggedById: selfFlagged.id },
    });
    await prisma.offboardFlag.create({
      data: { personId: otherFlagged.id, termId: active.id, flaggedById: viewer.id },
    });

    const view = await transitionView(viewer.id);

    const selfRow = view.rows.find((r) => r.personId === selfFlagged.id);
    const otherRow = view.rows.find((r) => r.personId === otherFlagged.id);
    expect(selfRow?.flagged).toBe(true);
    expect(selfRow?.selfWithdrew).toBe(true);
    expect(otherRow?.flagged).toBe(true);
    expect(otherRow?.selfWithdrew).toBe(false);
  });

  it("scopes a director to their own departments", async () => {
    const active = await createTerm("ACTIVE", "FA25", "2025-08-01");
    await createTerm("PLANNING", "SP26", "2026-01-01");
    const mine = await createDepartment("ITCM");
    const theirs = await createDepartment("SRR");
    const director = await createPerson("Dir", "dir01");
    await createMembership(director.id, active.id, mine.id, "DIRECTOR");
    const inScope = await createPerson("Mine", "min01");
    const outOfScope = await createPerson("Theirs", "the01");
    await createMembership(inScope.id, active.id, mine.id);
    await createMembership(outOfScope.id, active.id, theirs.id);

    const view = await transitionView(director.id);

    const ids = view.rows.map((r) => r.personId);
    expect(ids).toContain(inScope.id);
    expect(ids).not.toContain(outOfScope.id);
  });

  it("shows clinic-wide rows to a manage_offboarding holder with no directorship", async () => {
    const active = await createTerm("ACTIVE", "FA25", "2025-08-01");
    await createTerm("PLANNING", "SP26", "2026-01-01");
    const dept = await createDepartment("SRR");
    const viewer = await createPerson("Exec", "exec01");
    await grantPermission(viewer.id, "volunteers.manage_offboarding");
    const member = await createPerson("Somebody", "som01");
    await createMembership(member.id, active.id, dept.id);

    const view = await transitionView(viewer.id);

    expect(view.rows.map((r) => r.personId)).toContain(member.id);
  });

  it("returns no rows for a viewer with neither the permission nor a directorship", async () => {
    const active = await createTerm("ACTIVE", "FA25", "2025-08-01");
    await createTerm("PLANNING", "SP26", "2026-01-01");
    const dept = await createDepartment("SRR");
    const viewer = await createPerson("Nobody", "nob01");
    const member = await createPerson("Somebody", "som01");
    await createMembership(viewer.id, active.id, dept.id);
    await createMembership(member.id, active.id, dept.id);

    const view = await transitionView(viewer.id);

    expect(view.rows).toEqual([]);
  });
});
