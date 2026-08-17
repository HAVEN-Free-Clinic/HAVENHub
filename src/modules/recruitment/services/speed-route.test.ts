import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetDb } from "@/platform/test/db";
import { prisma } from "@/platform/db";
import { RecruitmentAuthError } from "./review";
import { RoutingError } from "./routing";
import { loadSpeedRouteBoard } from "./speed-route";

async function seed() {
  const term = await prisma.term.create({ data: { code: "FA26", name: "Fall", startDate: new Date(), endDate: new Date(), status: "ACTIVE" } });
  await prisma.department.create({ data: { code: "EDUC", name: "Education" } });
  await prisma.department.create({ data: { code: "MDIC", name: "Medical" } });
  const lead = await prisma.person.create({ data: { name: "Lead", status: "ACTIVE" } });
  const other = await prisma.person.create({ data: { name: "Other", status: "ACTIVE" } });
  const scorer = await prisma.person.create({ data: { name: "Scorer", status: "ACTIVE" } });
  const srr = await prisma.role.create({ data: { name: "SRR", grants: { create: [{ permission: "recruitment.review_all" }] } } });
  await prisma.roleAssignment.create({ data: { personId: lead.id, roleId: srr.id } });
  const cycle = await prisma.recruitmentCycle.create({ data: { track: "VOLUNTEER", termId: term.id, title: "V", publicSlug: "v", departments: ["EDUC", "MDIC"], createdById: lead.id, status: "OPEN", routeTopPercent: 20, routeBottomPercent: 30 } });
  // Five submitted applicants; score four with distinct averages, leave one unscored.
  const scores = [5, 4, 3, 1, null] as const;
  const apps: string[] = [];
  for (let i = 0; i < scores.length; i++) {
    const applicant = await prisma.applicant.create({ data: { cycleId: cycle.id, firstName: `A${i}`, lastName: "B", email: `a${i}@y.edu`, emailLower: `a${i}@y.edu` } });
    const app = await prisma.application.create({ data: { cycleId: cycle.id, applicantId: applicant.id, answers: {}, applicantType: "NEW", departmentChoices: ["EDUC"] } });
    if (scores[i] != null) await prisma.committeeScore.create({ data: { applicationId: app.id, scorerId: scorer.id, score: scores[i]! } });
    apps.push(app.id);
  }
  return { lead, other, cycle, apps };
}

beforeEach(async () => { await resetDb(); });
afterEach(async () => { await resetDb(); });

describe("loadSpeedRouteBoard", () => {
  it("buckets scored applicants and lists the unscored separately", async () => {
    const { lead, cycle } = await seed();
    const board = await loadSpeedRouteBoard(cycle.id, lead.id);
    expect(board.topPercent).toBe(20);
    expect(board.bottomPercent).toBe(30);
    // N=4 scored -> top 1 (avg 5), bottom 1 (avg 1), middle 2 (avg 4 and 3).
    expect(board.top).toHaveLength(1);
    expect(board.top[0].average).toBe(5);
    expect(board.bottom).toHaveLength(1);
    expect(board.bottom[0].average).toBe(1);
    expect(board.middle).toHaveLength(2);
    expect(board.unscored).toHaveLength(1);
    expect(board.unscored[0].average).toBeNull();
  });

  it("proposes the applicant's first ranked choice when it is a cycle department", async () => {
    const { lead, cycle } = await seed();
    const board = await loadSpeedRouteBoard(cycle.id, lead.id);
    expect(board.top[0].proposedDepartmentCode).toBe("EDUC");
  });

  it("proposes null when the first ranked choice is not a cycle department", async () => {
    const { lead, cycle, apps } = await seed();
    await prisma.application.update({ where: { id: apps[0] }, data: { departmentChoices: ["GONE"] } });
    const board = await loadSpeedRouteBoard(cycle.id, lead.id);
    const row = [...board.top, ...board.middle, ...board.bottom].find((r) => r.applicationId === apps[0]);
    expect(row?.proposedDepartmentCode).toBeNull();
  });

  it("proposes null, not the decliner, once a department handed the applicant back (audit 14, REC-2)", async () => {
    const { lead, cycle, apps } = await seed();
    // EDUC is every seeded applicant's first (and only) ranked choice, so before
    // the fix this row proposed EDUC -- the department that just declined them --
    // as the default for the tier select and "Apply top tier".
    await prisma.application.update({
      where: { id: apps[0] },
      data: { returnedToRoutingAt: new Date(), returnedFromDepartmentCode: "EDUC" },
    });
    const board = await loadSpeedRouteBoard(cycle.id, lead.id);
    const row = [...board.top, ...board.middle, ...board.bottom].find((r) => r.applicationId === apps[0]);
    expect(row?.returnedFromDepartmentCode).toBe("EDUC");
    expect(row?.proposedDepartmentCode).toBeNull();
  });

  it("rejects a viewer without review_all", async () => {
    const { other, cycle } = await seed();
    await expect(loadSpeedRouteBoard(cycle.id, other.id)).rejects.toBeInstanceOf(RecruitmentAuthError);
  });

  it("rejects a director-track cycle", async () => {
    const { lead } = await seed();
    const term = await prisma.term.findFirstOrThrow();
    const dir = await prisma.recruitmentCycle.create({ data: { track: "DIRECTOR", termId: term.id, title: "D", publicSlug: "dboard", departments: ["EDUC"], createdById: lead.id, status: "OPEN" } });
    await expect(loadSpeedRouteBoard(dir.id, lead.id)).rejects.toBeInstanceOf(RoutingError);
  });
});
