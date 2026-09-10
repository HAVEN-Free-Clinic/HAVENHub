import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetDb } from "@/platform/test/db";
import { prisma } from "@/platform/db";
import { DUAL_ROLE_PERMISSION, DualRoleError, acceptDualRole, listDualRoleQueue } from "./index";

/**
 * Offers recorded for NEXT term, before the flip.
 *
 * Promotion records a dual-role offer against the cycle's term and mails the
 * receiving directors at once, and a cohort is promoted while its term is still
 * PLANNING. The queue used to read the live term only, so for the weeks before
 * the flip that digest linked to an empty page and a decision was refused as
 * "no longer exists".
 */

beforeEach(async () => {
  await resetDb();
});
afterEach(async () => {
  await resetDb();
});

const DAY = 24 * 60 * 60 * 1000;

async function seed() {
  const live = await prisma.term.create({
    data: {
      code: "SU26", name: "Summer 2026", status: "ACTIVE", clinicDates: [],
      startDate: new Date(Date.now() - 60 * DAY), endDate: new Date(Date.now() + 10 * DAY),
    },
  });
  const next = await prisma.term.create({
    data: {
      code: "FA26", name: "Fall 2026", status: "PLANNING", clinicDates: [],
      startDate: new Date(Date.now() + 5 * DAY), endDate: new Date(Date.now() + 120 * DAY),
    },
  });
  const [home, vadm, summerDept] = await Promise.all([
    prisma.department.create({ data: { code: "SRHD", name: "Sexual and Reproductive Health" } }),
    prisma.department.create({ data: { code: "VADM", name: "Vaccine Administration" } }),
    prisma.department.create({ data: { code: "PCAR", name: "Primary Care" } }),
  ]);
  const lead = await prisma.person.create({ data: { name: "Lead", status: "ACTIVE" } });
  const cycle = await prisma.recruitmentCycle.create({
    data: {
      track: "VOLUNTEER", termId: next.id, title: "Volunteer Fall 2026", publicSlug: "fa26",
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
      applicantType: "RENEWAL", departmentChoices: ["SRHD"], dualRoleDepartments: ["VADM"],
    },
  });
  // A returner: still serving the live term in one department, and promoted
  // onto next term's roster in another, exactly as the cohort is before a flip.
  const member = await prisma.person.create({
    data: { name: "Ada Lovelace", netId: "al99", status: "ACTIVE" },
  });
  await prisma.termMembership.createMany({
    data: [
      { personId: member.id, termId: live.id, departmentId: summerDept.id, kind: "VOLUNTEER", status: "ACTIVE" },
      { personId: member.id, termId: next.id, departmentId: home.id, kind: "VOLUNTEER", status: "ACTIVE" },
    ],
  });
  const offer = await prisma.dualRoleInterest.create({
    data: { applicationId: application.id, personId: member.id, termId: next.id, departmentCode: "VADM" },
  });

  // A continuing VADM director. Until the flip their grant resolves through
  // their live-term directorship, which is what permissionDepartmentIds reads.
  const director = await prisma.person.create({ data: { name: "Val Director", status: "ACTIVE" } });
  const role = await prisma.role.create({
    data: { name: "Director", isSystem: true, grants: { create: [{ permission: DUAL_ROLE_PERMISSION }] } },
  });
  await prisma.roleAssignment.create({ data: { roleId: role.id, kind: "DIRECTOR", termId: null } });
  await prisma.termMembership.create({
    data: { personId: director.id, termId: live.id, departmentId: vadm.id, kind: "DIRECTOR", status: "ACTIVE" },
  });

  return { live, next, home, vadm, member, offer, director, application };
}

describe("dual-role offers made for next term", () => {
  it("shows them before the flip, labelled with their term and next term's home department", async () => {
    const { director } = await seed();

    const rows = await listDualRoleQueue(director.id);

    expect(rows).toHaveLength(1);
    expect(rows[0].termName).toBe("Fall 2026");
    // Where they serve IN THE OFFER'S TERM, not the live-term department they
    // are finishing out.
    expect(rows[0].primaryDepartments).toEqual(["Sexual and Reproductive Health"]);
  });

  it("accepting puts them on next term's roster, not the live one", async () => {
    const { director, offer, member, next, live, vadm } = await seed();

    await acceptDualRole(director.id, offer.id);

    const onNext = await prisma.termMembership.findFirst({
      where: { personId: member.id, termId: next.id, departmentId: vadm.id, status: "ACTIVE" },
    });
    expect(onNext?.kind).toBe("VOLUNTEER");
    expect(
      await prisma.termMembership.count({
        where: { personId: member.id, termId: live.id, departmentId: vadm.id },
      }),
    ).toBe(0);
    expect((await prisma.dualRoleInterest.findUniqueOrThrow({ where: { id: offer.id } })).status).toBe("ACCEPTED");
  });

  it("still leaves an offer for a term that is over out of the queue and undecidable", async () => {
    const { director, member, application } = await seed();
    const past = await prisma.term.create({
      data: {
        code: "SP26", name: "Spring 2026", status: "ARCHIVED", clinicDates: [],
        startDate: new Date(Date.now() - 200 * DAY), endDate: new Date(Date.now() - 100 * DAY),
      },
    });
    const stale = await prisma.dualRoleInterest.create({
      data: { applicationId: application.id, personId: member.id, termId: past.id, departmentCode: "VADM" },
    });

    expect((await listDualRoleQueue(director.id)).map((r) => r.id)).not.toContain(stale.id);
    await expect(acceptDualRole(director.id, stale.id)).rejects.toThrow(DualRoleError);
  });
});
