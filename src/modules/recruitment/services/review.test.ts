import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetDb } from "@/platform/test/db";
import { prisma } from "@/platform/db";
import {
  reviewScope, listApplicantsForReview, listReviewableCycles, revokeAcceptance, listAcceptances,
  canViewApplication, RecruitmentAuthError, AcceptanceError,
} from "./review";

async function seed() {
  const term = await prisma.term.create({ data: { code: "FA26", name: "Fall 2026", startDate: new Date(), endDate: new Date(), status: "ACTIVE" } });
  const srhd = await prisma.department.create({ data: { code: "SRHD", name: "Student Run Health Dept" } });
  const mdic = await prisma.department.create({ data: { code: "MDIC", name: "Medical Dept" } });
  const director = await prisma.person.create({ data: { name: "Dir", status: "ACTIVE" } });
  await prisma.termMembership.create({ data: { personId: director.id, termId: term.id, departmentId: srhd.id, kind: "DIRECTOR", status: "ACTIVE" } });
  const srr = await prisma.person.create({ data: { name: "SRR", status: "ACTIVE" } });
  const role = await prisma.role.create({ data: { name: "Recruitment Admin", grants: { create: [{ permission: "recruitment.review_all" }] } } });
  await prisma.roleAssignment.create({ data: { personId: srr.id, roleId: role.id } });
  const scorer = await prisma.person.create({ data: { name: "Scorer", status: "ACTIVE" } });
  const scoreRole = await prisma.role.create({ data: { name: "Committee Scorer", grants: { create: [{ permission: "recruitment.score" }] } } });
  await prisma.roleAssignment.create({ data: { personId: scorer.id, roleId: scoreRole.id } });
  const cycle = await prisma.recruitmentCycle.create({ data: { track: "VOLUNTEER", termId: term.id, title: "V", publicSlug: "rv", departments: ["SRHD", "MDIC"], createdById: srr.id, status: "OPEN" } });
  const mkApp = async (email: string, choices: string[]) => {
    const applicant = await prisma.applicant.create({ data: { cycleId: cycle.id, firstName: "A", lastName: "B", email, emailLower: email.toLowerCase() } });
    return prisma.application.create({ data: { cycleId: cycle.id, applicantId: applicant.id, answers: {}, applicantType: "NEW", departmentChoices: choices } });
  };
  const appSrhd = await mkApp("s@yale.edu", ["SRHD"]);
  const appMdic = await mkApp("m@yale.edu", ["MDIC"]);
  return { term, srhd, mdic, director, srr, scorer, cycle, appSrhd, appMdic };
}

beforeEach(async () => { await resetDb(); });
afterEach(async () => { await resetDb(); });

describe("reviewScope", () => {
  it("resolves a director's department codes and the review_all flag", async () => {
    const { director, srr } = await seed();
    const dScope = await reviewScope(director.id);
    expect(dScope.all).toBe(false);
    expect(dScope.departmentCodes).toEqual(["SRHD"]);
    const sScope = await reviewScope(srr.id);
    expect(sScope.all).toBe(true);
  });
});

describe("listApplicantsForReview", () => {
  it("scopes a director to applicants ROUTED to their department, not merely those who ranked it", async () => {
    const { director, srr, cycle, appMdic } = await seed();
    // appMdic ranked MDIC but the committee routed it to SRHD (the director's dept);
    // appSrhd (in the seed) ranked SRHD but was never routed, so the director must not see it.
    await prisma.application.update({
      where: { id: appMdic.id },
      data: { routedDepartmentCode: "SRHD", routedById: srr.id, routedAt: new Date() },
    });
    const apps = await listApplicantsForReview(cycle.id, director.id);
    expect(apps.map((a) => a.id)).toEqual([appMdic.id]);
  });
  it("on a DIRECTOR-track cycle, scopes a director to applicants who RANKED their department (no routing stage exists), filtering out non-matching apps", async () => {
    const { term, director, srr } = await seed();
    const dCycle = await prisma.recruitmentCycle.create({
      data: { track: "DIRECTOR", termId: term.id, title: "D", publicSlug: "director-cycle", departments: ["SRHD", "MDIC"], createdById: srr.id, status: "OPEN" },
    });
    const mkApp = async (email: string, choices: string[]) => {
      const applicant = await prisma.applicant.create({ data: { cycleId: dCycle.id, firstName: "C", lastName: "D", email, emailLower: email.toLowerCase() } });
      return prisma.application.create({ data: { cycleId: dCycle.id, applicantId: applicant.id, answers: {}, applicantType: "NEW", departmentChoices: choices } });
    };
    const ranksSrhd = await mkApp("srhd@yale.edu", ["SRHD"]); // the director's dept
    await mkApp("mdic@yale.edu", ["MDIC"]); // a DIFFERENT dept -- must be filtered out
    const apps = await listApplicantsForReview(dCycle.id, director.id);
    expect(apps.map((a) => a.id)).toEqual([ranksSrhd.id]);
  });
  it("shows SRR every applicant", async () => {
    const { srr, cycle } = await seed();
    const apps = await listApplicantsForReview(cycle.id, srr.id);
    expect(apps).toHaveLength(2);
  });
  it("shows a committee scorer (recruitment.score only) every applicant, with committeeScores included", async () => {
    const { scorer, cycle, appSrhd, appMdic } = await seed();
    await prisma.committeeScore.create({ data: { applicationId: appSrhd.id, scorerId: scorer.id, score: 4 } });
    const apps = await listApplicantsForReview(cycle.id, scorer.id);
    expect(apps).toHaveLength(2);
    const unscored = apps.find((a) => a.id === appMdic.id)!;
    expect(unscored.committeeScores).toEqual([]);
    const scored = apps.find((a) => a.id === appSrhd.id)!;
    expect(scored.committeeScores[0]).toMatchObject({ score: 4, scorerId: scorer.id });
    expect(scored.applicant).toHaveProperty("applicantPersonId");
  });
});

describe("listReviewableCycles", () => {
  it("gives a committee scorer (recruitment.score only) any cycle with a submitted application, both tracks", async () => {
    const { term, scorer, srr, cycle } = await seed();
    const dCycle = await prisma.recruitmentCycle.create({
      data: { track: "DIRECTOR", termId: term.id, title: "DS", publicSlug: "dir-scored", departments: ["SRHD"], createdById: srr.id, status: "OPEN" },
    });
    const applicant = await prisma.applicant.create({ data: { cycleId: dCycle.id, firstName: "S", lastName: "C", email: "sc@yale.edu", emailLower: "sc@yale.edu" } });
    await prisma.application.create({ data: { cycleId: dCycle.id, applicantId: applicant.id, answers: {}, applicantType: "NEW", departmentChoices: ["SRHD"] } });
    const ids = (await listReviewableCycles(scorer.id)).map((c) => c.id);
    expect(ids).toContain(cycle.id); // volunteer seed cycle
    expect(ids).toContain(dCycle.id); // director cycle: committee scores both tracks
  });
  it("gives a scope-director a volunteer cycle with an app ROUTED to their department, but not one with only a ranked (unrouted) app", async () => {
    const { term, director, srr, cycle: unroutedCycle } = await seed();
    // unroutedCycle ("V") has an app that ranked SRHD but was never routed --
    // must not surface for a director whose queue is routing-driven on VOLUNTEER cycles.
    const routedCycle = await prisma.recruitmentCycle.create({
      data: { track: "VOLUNTEER", termId: term.id, title: "Routed", publicSlug: "routed-cycle", departments: ["SRHD", "MDIC"], createdById: srr.id, status: "OPEN" },
    });
    const applicant = await prisma.applicant.create({ data: { cycleId: routedCycle.id, firstName: "R", lastName: "T", email: "r@yale.edu", emailLower: "r@yale.edu" } });
    await prisma.application.create({
      data: { cycleId: routedCycle.id, applicantId: applicant.id, answers: {}, applicantType: "NEW", departmentChoices: ["MDIC"], routedDepartmentCode: "SRHD", routedById: srr.id, routedAt: new Date() },
    });
    const cycles = await listReviewableCycles(director.id);
    const ids = cycles.map((c) => c.id);
    expect(ids).toContain(routedCycle.id);
    expect(ids).not.toContain(unroutedCycle.id);
  });
  it("gives a scope-director a DIRECTOR-track cycle whose app RANKS their department (routing does not apply)", async () => {
    const { term, director, srr } = await seed();
    const dCycle = await prisma.recruitmentCycle.create({
      data: { track: "DIRECTOR", termId: term.id, title: "D", publicSlug: "director-cycle", departments: ["SRHD", "MDIC"], createdById: srr.id, status: "OPEN" },
    });
    const applicant = await prisma.applicant.create({ data: { cycleId: dCycle.id, firstName: "C", lastName: "D", email: "cd@yale.edu", emailLower: "cd@yale.edu" } });
    await prisma.application.create({
      data: { cycleId: dCycle.id, applicantId: applicant.id, answers: {}, applicantType: "NEW", departmentChoices: ["SRHD"] },
    });
    const cycles = await listReviewableCycles(director.id);
    expect(cycles.map((c) => c.id)).toContain(dCycle.id);
  });
});

describe("listAcceptances", () => {
  it("returns an application's acceptances in creation order", async () => {
    const { srr, appSrhd } = await seed();
    await prisma.acceptance.create({ data: { applicationId: appSrhd.id, departmentCode: "SRHD", approvedById: srr.id, notes: "a" } });
    await prisma.acceptance.create({ data: { applicationId: appSrhd.id, departmentCode: "MDIC", approvedById: srr.id, notes: "b" } });
    const accs = await listAcceptances(appSrhd.id);
    expect(accs.map((x) => x.departmentCode)).toEqual(["SRHD", "MDIC"]);
  });
});

describe("revokeAcceptance", () => {
  it("lets an in-scope director revoke an un-emailed acceptance", async () => {
    const { director, appSrhd } = await seed();
    const acc = await prisma.acceptance.create({ data: { applicationId: appSrhd.id, departmentCode: "SRHD", approvedById: director.id } });
    await revokeAcceptance(acc.id, director.id);
    expect(await prisma.acceptance.findUnique({ where: { id: acc.id } })).toBeNull();
  });
  it("blocks a director from revoking an already-emailed acceptance, but allows SRR", async () => {
    const { director, srr, appSrhd } = await seed();
    const acc = await prisma.acceptance.create({ data: { applicationId: appSrhd.id, departmentCode: "SRHD", approvedById: director.id } });
    await prisma.acceptance.update({ where: { id: acc.id }, data: { emailedAt: new Date() } });
    await expect(revokeAcceptance(acc.id, director.id)).rejects.toBeInstanceOf(RecruitmentAuthError);
    await revokeAcceptance(acc.id, srr.id);
    expect(await prisma.acceptance.findUnique({ where: { id: acc.id } })).toBeNull();
  });
  it("refuses to revoke an acceptance that has an onboarding contract (would cascade-delete it), even for SRR", async () => {
    const { srr, appSrhd } = await seed();
    const acc = await prisma.acceptance.create({ data: { applicationId: appSrhd.id, departmentCode: "SRHD", approvedById: srr.id } });
    await prisma.onboardingContract.create({
      data: { acceptanceId: acc.id, token: "tok-contract", firstName: "A", lastName: "B", email: "s@yale.edu" },
    });
    await expect(revokeAcceptance(acc.id, srr.id)).rejects.toBeInstanceOf(AcceptanceError);
    // The acceptance and its contract must survive.
    expect(await prisma.acceptance.findUnique({ where: { id: acc.id } })).not.toBeNull();
    expect(await prisma.onboardingContract.count()).toBe(1);
  });
});

describe("canViewApplication (pure, mirrors listApplicantsForReview)", () => {
  const dirScope = { all: false, departmentCodes: ["SRHD"] };
  const noScope = { all: false, departmentCodes: [] as string[] };
  const flags = (o: Partial<{ managesCycles: boolean; canScore: boolean }> = {}) => ({
    managesCycles: o.managesCycles ?? false,
    canScore: o.canScore ?? false,
  });
  const volApp = (o: Partial<{ choices: string[]; routed: string | null }> = {}) => ({
    departmentChoices: o.choices ?? ["SRHD"],
    routedDepartmentCode: o.routed ?? null,
    cycle: { track: "VOLUNTEER" },
  });
  const dirApp = (choices: string[]) => ({ departmentChoices: choices, routedDepartmentCode: null, cycle: { track: "DIRECTOR" } });

  it("SRR (review_all) sees any application", () => {
    expect(canViewApplication(volApp(), { scope: { all: true, departmentCodes: [] }, ...flags() })).toBe(true);
  });
  it("cycle managers and committee scorers see any application", () => {
    expect(canViewApplication(volApp({ choices: ["MDIC"] }), { scope: noScope, ...flags({ managesCycles: true }) })).toBe(true);
    expect(canViewApplication(volApp({ choices: ["MDIC"] }), { scope: noScope, ...flags({ canScore: true }) })).toBe(true);
  });
  it("volunteer cycle: a director sees an app ROUTED to their dept, not merely ranked", () => {
    // ranked their dept but routed elsewhere -> hidden (this is the #10 fix)
    expect(canViewApplication(volApp({ choices: ["SRHD"], routed: "MDIC" }), { scope: dirScope, ...flags() })).toBe(false);
    // routed to their dept -> visible
    expect(canViewApplication(volApp({ choices: ["MDIC"], routed: "SRHD" }), { scope: dirScope, ...flags() })).toBe(true);
    // not yet routed -> hidden
    expect(canViewApplication(volApp({ choices: ["SRHD"], routed: null }), { scope: dirScope, ...flags() })).toBe(false);
  });
  it("director-track cycle: a director sees an app that RANKED their dept", () => {
    expect(canViewApplication(dirApp(["SRHD"]), { scope: dirScope, ...flags() })).toBe(true);
    expect(canViewApplication(dirApp(["MDIC"]), { scope: dirScope, ...flags() })).toBe(false);
  });
});
