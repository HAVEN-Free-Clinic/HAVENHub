import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetDb } from "@/platform/test/db";
import { prisma } from "@/platform/db";
import {
  DUAL_ROLE_PERMISSION,
  DualRoleError,
  acceptDualRole,
  declineDualRole,
  directsADualRoleDepartment,
  listDualRoleQueue,
} from "./index";

/**
 * The queue and the decisions: who can see an offer, and what accepting or
 * declining one actually does.
 *
 * Offers are seeded directly here rather than driven through a promotion. What
 * PUTS them in the table is recruitment's job and is tested there
 * (services/promotion.dual-roles.test.ts); platform code may not import a
 * module, and the two halves are worth being able to break independently.
 */

beforeEach(async () => {
  await resetDb();
});
afterEach(async () => {
  await resetDb();
});

/** A term, the two dual departments, a home department, and one applicant. */
async function seed() {
  const term = await prisma.term.create({
    data: {
      code: "FA26", name: "Fall", startDate: new Date(), endDate: new Date(),
      status: "ACTIVE", clinicDates: [],
    },
  });
  const [home, vadm, intp] = await Promise.all([
    prisma.department.create({ data: { code: "SRHD", name: "Sexual and Reproductive Health" } }),
    prisma.department.create({ data: { code: "VADM", name: "Vaccine Administration" } }),
    prisma.department.create({ data: { code: "INTP", name: "Interpreting and Diversity" } }),
  ]);
  const lead = await prisma.person.create({ data: { name: "Lead", status: "ACTIVE" } });
  const cycle = await prisma.recruitmentCycle.create({
    data: {
      track: "VOLUNTEER", termId: term.id, title: "V", publicSlug: `v-${Math.random()}`,
      departments: ["SRHD"], createdById: lead.id, status: "OPEN",
    },
  });
  const applicant = await prisma.applicant.create({
    data: {
      cycleId: cycle.id, firstName: "Ada", lastName: "Lovelace",
      email: "ada@yale.edu", emailLower: "ada@yale.edu",
    },
  });
  const application = await prisma.application.create({
    data: {
      cycleId: cycle.id, applicantId: applicant.id, answers: {},
      applicantType: "NEW", departmentChoices: ["SRHD"], dualRoleDepartments: ["VADM"],
    },
  });
  // The volunteer, already on their home roster, as promotion would have left them.
  const member = await prisma.person.create({
    data: { name: "Ada Lovelace", netId: "al99", status: "ACTIVE" },
  });
  await prisma.termMembership.create({
    data: {
      personId: member.id, termId: term.id, departmentId: home.id,
      kind: "VOLUNTEER", status: "ACTIVE",
    },
  });
  return { term, home, vadm, intp, application, member };
}

/** A PENDING offer from the seeded member to `departmentCode`. */
async function offerTo(
  ctx: Awaited<ReturnType<typeof seed>>,
  departmentCode: string,
) {
  return prisma.dualRoleInterest.create({
    data: {
      applicationId: ctx.application.id,
      personId: ctx.member.id,
      termId: ctx.term.id,
      departmentCode,
    },
  });
}

/**
 * A director of `department`, carrying the grant the way production does: a
 * KIND-targeted role assignment plus an ACTIVE DIRECTOR membership, which is
 * what makes permissionDepartmentIds resolve to that department and no other.
 */
async function seedDirector(name: string, termId: string, departmentId: string) {
  const person = await prisma.person.create({ data: { name, status: "ACTIVE" } });
  const role = await prisma.role.upsert({
    where: { name: "Director" },
    update: {},
    create: {
      name: "Director",
      isSystem: true,
      grants: { create: [{ permission: DUAL_ROLE_PERMISSION }] },
    },
  });
  await prisma.roleAssignment.upsert({
    where: { id: `ra-${role.id}` },
    update: {},
    create: { id: `ra-${role.id}`, roleId: role.id, kind: "DIRECTOR", termId },
  });
  await prisma.termMembership.create({
    data: { personId: person.id, termId, departmentId, kind: "DIRECTOR", status: "ACTIVE" },
  });
  return person;
}

describe("listDualRoleQueue", () => {
  it("shows a director the offers made to the department they direct", async () => {
    const ctx = await seed();
    await offerTo(ctx, "VADM");
    const director = await seedDirector("Val Director", ctx.term.id, ctx.vadm.id);

    const rows = await listDualRoleQueue(director.id);

    expect(rows).toHaveLength(1);
    expect(rows[0].departmentCode).toBe("VADM");
    expect(rows[0].personName).toBe("Ada Lovelace");
    // Where they already serve, so the director knows who they are borrowing from.
    expect(rows[0].primaryDepartments).toEqual(["Sexual and Reproductive Health"]);
    expect(rows[0].status).toBe("PENDING");
  });

  it("hides another department's offers from a director who does not direct it", async () => {
    // The load-bearing scoping assertion: the grant is clinic-wide, the queue is
    // not. An INTP director must never see VADM's offers.
    const ctx = await seed();
    await offerTo(ctx, "VADM");
    const intpDirector = await seedDirector("Ines Director", ctx.term.id, ctx.intp.id);

    expect(await listDualRoleQueue(intpDirector.id)).toEqual([]);
  });

  it("returns nothing for a director of a department nobody can offer to", async () => {
    const ctx = await seed();
    await offerTo(ctx, "VADM");
    const homeDirector = await seedDirector("Hal Director", ctx.term.id, ctx.home.id);

    expect(await listDualRoleQueue(homeDirector.id)).toEqual([]);
    // The same fact the Volunteers nav asks before rendering the tab at all.
    expect(await directsADualRoleDepartment(homeDirector.id)).toBe(false);
  });

  it("tells the nav that a VADM director does have a queue", async () => {
    const ctx = await seed();
    const director = await seedDirector("Val Director", ctx.term.id, ctx.vadm.id);
    expect(await directsADualRoleDepartment(director.id)).toBe(true);
  });

  it("omits decided offers unless asked for them", async () => {
    const ctx = await seed();
    const offer = await offerTo(ctx, "VADM");
    const director = await seedDirector("Val Director", ctx.term.id, ctx.vadm.id);
    await declineDualRole(director.id, offer.id, "No licence");

    expect(await listDualRoleQueue(director.id)).toEqual([]);
    const all = await listDualRoleQueue(director.id, { includeDecided: true });
    expect(all).toHaveLength(1);
    expect(all[0].status).toBe("DECLINED");
    expect(all[0].decidedByName).toBe("Val Director");
    expect(all[0].notes).toBe("No licence");
  });
});

describe("deciding an offer", () => {
  it("accepting puts the person on the roster as a VOLUNTEER and records the decision", async () => {
    const ctx = await seed();
    const offer = await offerTo(ctx, "VADM");
    const director = await seedDirector("Val Director", ctx.term.id, ctx.vadm.id);

    await acceptDualRole(director.id, offer.id, "RN licence verified");

    const membership = await prisma.termMembership.findFirstOrThrow({
      where: { personId: ctx.member.id, termId: ctx.term.id, departmentId: ctx.vadm.id },
    });
    expect(membership.kind).toBe("VOLUNTEER");
    expect(membership.status).toBe("ACTIVE");
    // Their original department is untouched: a dual role is additive, never a move.
    expect(
      await prisma.termMembership.count({
        where: { personId: ctx.member.id, termId: ctx.term.id, status: "ACTIVE" },
      }),
    ).toBe(2);

    const decided = await prisma.dualRoleInterest.findUniqueOrThrow({ where: { id: offer.id } });
    expect(decided.status).toBe("ACCEPTED");
    expect(decided.decidedById).toBe(director.id);
    expect(decided.notes).toBe("RN licence verified");
  });

  it("declining records the reason and creates no membership", async () => {
    const ctx = await seed();
    const offer = await offerTo(ctx, "VADM");
    const director = await seedDirector("Val Director", ctx.term.id, ctx.vadm.id);

    await declineDualRole(director.id, offer.id, "No CT licence on file");

    // Scoped to the applicant: VADM's own director holds a membership here too.
    expect(
      await prisma.termMembership.count({
        where: { personId: ctx.member.id, termId: ctx.term.id, departmentId: ctx.vadm.id },
      }),
    ).toBe(0);
    const decided = await prisma.dualRoleInterest.findUniqueOrThrow({ where: { id: offer.id } });
    expect(decided.status).toBe("DECLINED");
    expect(decided.notes).toBe("No CT licence on file");
  });

  it("refuses a director deciding another department's offer", async () => {
    // The write-side half of the scoping guard. Filtering the queue read is a
    // convenience; this is what stops a hand-made request.
    const ctx = await seed();
    const offer = await offerTo(ctx, "VADM");
    const intpDirector = await seedDirector("Ines Director", ctx.term.id, ctx.intp.id);

    await expect(acceptDualRole(intpDirector.id, offer.id)).rejects.toThrow(DualRoleError);
    expect(
      await prisma.termMembership.count({
        where: { personId: ctx.member.id, termId: ctx.term.id, departmentId: ctx.vadm.id },
      }),
    ).toBe(0);
    expect(
      (await prisma.dualRoleInterest.findUniqueOrThrow({ where: { id: offer.id } })).status,
    ).toBe("PENDING");
  });

  it("refuses to decide an offer twice", async () => {
    const ctx = await seed();
    const offer = await offerTo(ctx, "VADM");
    const director = await seedDirector("Val Director", ctx.term.id, ctx.vadm.id);
    await acceptDualRole(director.id, offer.id);

    await expect(declineDualRole(director.id, offer.id)).rejects.toThrow(DualRoleError);
  });

  it("refuses to put an offboarded person back on a roster", async () => {
    // Inherited from addMembership's offboard-convergence guard rather than
    // re-implemented here: an offer made in September must not resurrect someone
    // offboarded in November.
    const ctx = await seed();
    const offer = await offerTo(ctx, "VADM");
    const director = await seedDirector("Val Director", ctx.term.id, ctx.vadm.id);
    await prisma.person.update({
      where: { id: ctx.member.id },
      data: { status: "OFFBOARDED" },
    });

    await expect(acceptDualRole(director.id, offer.id)).rejects.toThrow();
    // Still PENDING: never marked accepted for somebody who never reached the roster.
    expect(
      (await prisma.dualRoleInterest.findUniqueOrThrow({ where: { id: offer.id } })).status,
    ).toBe("PENDING");
  });
});
