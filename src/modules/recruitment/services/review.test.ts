import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetDb } from "@/platform/test/db";
import { prisma } from "@/platform/db";
import {
  reviewScope, listApplicantsForReview, acceptApplicant, revokeAcceptance,
  RecruitmentAuthError, AcceptanceError,
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
  const cycle = await prisma.recruitmentCycle.create({ data: { track: "VOLUNTEER", termId: term.id, title: "V", publicSlug: "rv", departments: ["SRHD", "MDIC"], createdById: srr.id, status: "OPEN" } });
  const mkApp = async (email: string, choices: string[]) => {
    const applicant = await prisma.applicant.create({ data: { cycleId: cycle.id, firstName: "A", lastName: "B", email, emailLower: email.toLowerCase() } });
    return prisma.application.create({ data: { cycleId: cycle.id, applicantId: applicant.id, answers: {}, applicantType: "NEW", departmentChoices: choices } });
  };
  const appSrhd = await mkApp("s@yale.edu", ["SRHD"]);
  const appMdic = await mkApp("m@yale.edu", ["MDIC"]);
  return { term, srhd, mdic, director, srr, cycle, appSrhd, appMdic };
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
  it("scopes a director to applicants who ranked their department", async () => {
    const { director, cycle, appSrhd } = await seed();
    const apps = await listApplicantsForReview(cycle.id, director.id);
    expect(apps.map((a) => a.id)).toEqual([appSrhd.id]);
  });
  it("shows SRR every applicant", async () => {
    const { srr, cycle } = await seed();
    const apps = await listApplicantsForReview(cycle.id, srr.id);
    expect(apps).toHaveLength(2);
  });
});

describe("acceptApplicant", () => {
  it("lets a director accept into their own department with notes + audit", async () => {
    const { director, appSrhd } = await seed();
    const acc = await acceptApplicant(appSrhd.id, "SRHD", director.id, "great fit");
    expect(acc.departmentCode).toBe("SRHD");
    const audit = await prisma.auditLog.findFirst({ where: { action: "recruitment.accept" } });
    expect(audit).not.toBeNull();
  });
  it("rejects a director accepting into a department they don't direct", async () => {
    const { director, appMdic } = await seed();
    await expect(acceptApplicant(appMdic.id, "MDIC", director.id, null)).rejects.toBeInstanceOf(RecruitmentAuthError);
  });
  it("rejects a director accepting into a department the applicant didn't rank", async () => {
    const { director, appSrhd } = await seed();
    await expect(acceptApplicant(appSrhd.id, "MDIC", director.id, null)).rejects.toBeInstanceOf(RecruitmentAuthError);
  });
  it("lets SRR place an applicant into any cycle department (flexibility), even one not ranked", async () => {
    const { srr, appSrhd } = await seed();
    const acc = await acceptApplicant(appSrhd.id, "MDIC", srr.id, null);
    expect(acc.departmentCode).toBe("MDIC");
  });
  it("rejects a department not in the cycle", async () => {
    const { srr, appSrhd } = await seed();
    await expect(acceptApplicant(appSrhd.id, "ZZZ", srr.id, null)).rejects.toBeInstanceOf(AcceptanceError);
  });
  it("rejects a duplicate acceptance", async () => {
    const { director, appSrhd } = await seed();
    await acceptApplicant(appSrhd.id, "SRHD", director.id, null);
    await expect(acceptApplicant(appSrhd.id, "SRHD", director.id, null)).rejects.toBeInstanceOf(AcceptanceError);
  });
});

describe("revokeAcceptance", () => {
  it("lets an in-scope director revoke an un-emailed acceptance", async () => {
    const { director, appSrhd } = await seed();
    const acc = await acceptApplicant(appSrhd.id, "SRHD", director.id, null);
    await revokeAcceptance(acc.id, director.id);
    expect(await prisma.acceptance.findUnique({ where: { id: acc.id } })).toBeNull();
  });
  it("blocks a director from revoking an already-emailed acceptance, but allows SRR", async () => {
    const { director, srr, appSrhd } = await seed();
    const acc = await acceptApplicant(appSrhd.id, "SRHD", director.id, null);
    await prisma.acceptance.update({ where: { id: acc.id }, data: { emailedAt: new Date() } });
    await expect(revokeAcceptance(acc.id, director.id)).rejects.toBeInstanceOf(RecruitmentAuthError);
    await revokeAcceptance(acc.id, srr.id);
    expect(await prisma.acceptance.findUnique({ where: { id: acc.id } })).toBeNull();
  });
});
