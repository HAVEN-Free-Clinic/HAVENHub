import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetDb } from "@/platform/test/db";
import { prisma } from "@/platform/db";
import { runRecruitmentReviewDigest, pendingReviewCount } from "./review-digest";

async function seed() {
  const term = await prisma.term.create({ data: { code: "FA26", name: "Fall", startDate: new Date(), endDate: new Date(), status: "ACTIVE" } });
  const educ = await prisma.department.create({ data: { code: "EDUC", name: "Education" } });
  const mdic = await prisma.department.create({ data: { code: "MDIC", name: "Medical" } });
  const director = await prisma.person.create({ data: { name: "Dana Director", status: "ACTIVE", contactEmail: "dana@yale.edu" } });
  await prisma.termMembership.create({ data: { personId: director.id, termId: term.id, departmentId: educ.id, kind: "DIRECTOR", status: "ACTIVE" } });
  const idle = await prisma.person.create({ data: { name: "Ida Idle", status: "ACTIVE", contactEmail: "ida@yale.edu" } });
  await prisma.termMembership.create({ data: { personId: idle.id, termId: term.id, departmentId: mdic.id, kind: "DIRECTOR", status: "ACTIVE" } });
  const cycle = await prisma.recruitmentCycle.create({ data: { track: "VOLUNTEER", termId: term.id, title: "V", publicSlug: "v", departments: ["EDUC", "MDIC"], createdById: director.id, status: "OPEN" } });
  const applicant = await prisma.applicant.create({ data: { cycleId: cycle.id, firstName: "A", lastName: "B", email: "a@y.edu", emailLower: "a@y.edu" } });
  // Routed to EDUC (Dana's dept), still PENDING.
  await prisma.application.create({ data: { cycleId: cycle.id, applicantId: applicant.id, answers: {}, applicantType: "NEW", departmentChoices: ["EDUC"], routedDepartmentCode: "EDUC" } });
  return { director, idle, cycle };
}

beforeEach(async () => { await resetDb(); });
afterEach(async () => { await resetDb(); });

describe("runRecruitmentReviewDigest", () => {
  it("notifies a director with a routed, undecided application; skips one with nothing", async () => {
    const { director, idle } = await seed();
    const r = await runRecruitmentReviewDigest();
    expect(r.directors).toBe(2);
    expect(r.notified).toBe(1);
    const danaNotes = await prisma.notification.findMany({ where: { personId: director.id, type: "recruitment.review_digest" } });
    expect(danaNotes).toHaveLength(1);
    expect(danaNotes[0].title).toContain("1 application");
    expect(await prisma.notification.findMany({ where: { personId: idle.id, type: "recruitment.review_digest" } })).toHaveLength(0);
  });

  it("does not notify once the routed application is decided", async () => {
    const { director, cycle } = await seed();
    const app = await prisma.application.findFirstOrThrow({ where: { cycleId: cycle.id } });
    await prisma.application.update({ where: { id: app.id }, data: { decision: "ACCEPT" } });
    const r = await runRecruitmentReviewDigest();
    expect(r.notified).toBe(0);
    expect(await prisma.notification.findMany({ where: { personId: director.id, type: "recruitment.review_digest" } })).toHaveLength(0);
  });

  it("is idempotent per day: a second run does not re-notify", async () => {
    const { director } = await seed();
    const first = await runRecruitmentReviewDigest();
    const second = await runRecruitmentReviewDigest();
    expect(first.notified).toBe(1);
    expect(second.notified).toBe(0);
    expect(await prisma.notification.findMany({ where: { personId: director.id, type: "recruitment.review_digest" } })).toHaveLength(1);
  });
});

describe("pendingReviewCount", () => {
  it("counts volunteer routed-undecided in the given departments", async () => {
    await seed();
    expect(await pendingReviewCount(["EDUC"])).toBe(1);
    expect(await pendingReviewCount(["MDIC"])).toBe(0);
    expect(await pendingReviewCount([])).toBe(0);
  });

  it("counts a director-track applicant ranking the department with no decided interview", async () => {
    const term = await prisma.term.create({ data: { code: "SP26", name: "Spring", startDate: new Date(), endDate: new Date(), status: "ACTIVE" } });
    await prisma.department.create({ data: { code: "EXEC", name: "Executive" } });
    const creator = await prisma.person.create({ data: { name: "C", status: "ACTIVE" } });
    const cycle = await prisma.recruitmentCycle.create({ data: { track: "DIRECTOR", termId: term.id, title: "D", publicSlug: "d", departments: ["EXEC"], createdById: creator.id, status: "OPEN" } });
    const applicant = await prisma.applicant.create({ data: { cycleId: cycle.id, firstName: "E", lastName: "F", email: "ef@y.edu", emailLower: "ef@y.edu" } });
    await prisma.application.create({ data: { cycleId: cycle.id, applicantId: applicant.id, answers: {}, applicantType: "NEW", departmentChoices: ["EXEC"] } });
    expect(await pendingReviewCount(["EXEC"])).toBe(1);
  });
});
