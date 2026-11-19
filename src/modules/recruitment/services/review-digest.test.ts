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

  it("does not notify a director about a cycle they applied in", async () => {
    const { director, cycle } = await seed();
    // Dana applies in the cycle she would review, signed out, under her address.
    const mine = await prisma.applicant.create({ data: { cycleId: cycle.id, firstName: "Dana", lastName: "D", email: "Dana@yale.edu", emailLower: "dana@yale.edu" } });
    await prisma.application.create({ data: { cycleId: cycle.id, applicantId: mine.id, answers: {}, applicantType: "NEW", departmentChoices: ["EDUC"], routedDepartmentCode: "EDUC" } });
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
    const { idle } = await seed();
    expect(await pendingReviewCount(["EDUC"], idle.id)).toBe(1);
    expect(await pendingReviewCount(["MDIC"], idle.id)).toBe(0);
    expect(await pendingReviewCount([], idle.id)).toBe(0);
  });

  it("counts a director-track applicant only once an interview is pending, and drains when it is decided", async () => {
    const term = await prisma.term.create({ data: { code: "SP26", name: "Spring", startDate: new Date(), endDate: new Date(), status: "ACTIVE" } });
    await prisma.department.create({ data: { code: "EXEC", name: "Executive" } });
    const creator = await prisma.person.create({ data: { name: "C", status: "ACTIVE" } });
    const cycle = await prisma.recruitmentCycle.create({ data: { track: "DIRECTOR", termId: term.id, title: "D", publicSlug: "d", departments: ["EXEC"], createdById: creator.id, status: "OPEN" } });
    const applicant = await prisma.applicant.create({ data: { cycleId: cycle.id, firstName: "E", lastName: "F", email: "ef@y.edu", emailLower: "ef@y.edu" } });
    const application = await prisma.application.create({ data: { cycleId: cycle.id, applicantId: applicant.id, answers: {}, applicantType: "NEW", departmentChoices: ["EXEC"] } });
    // Ranked EXEC but never interviewed: not outstanding work, so the digest
    // does not grow forever with everyone the department passed over.
    expect(await pendingReviewCount(["EXEC"], creator.id)).toBe(0);
    const iv = await prisma.interview.create({ data: { applicationId: application.id, departmentCode: "EXEC", createdById: creator.id } });
    expect(await pendingReviewCount(["EXEC"], creator.id)).toBe(1);
    await prisma.interview.update({ where: { id: iv.id }, data: { decision: "ACCEPT" } });
    expect(await pendingReviewCount(["EXEC"], creator.id)).toBe(0);
  });

  it("never counts a cycle the director applied in, or their own application", async () => {
    const term = await prisma.term.create({ data: { code: "SP27", name: "Spring", startDate: new Date(), endDate: new Date(), status: "ACTIVE" } });
    await prisma.department.create({ data: { code: "EXEC", name: "Executive" } });
    const director = await prisma.person.create({ data: { name: "Dee", status: "ACTIVE", netId: "dee9", contactEmail: "dee@gmail.com" } });
    const cycle = await prisma.recruitmentCycle.create({ data: { track: "DIRECTOR", termId: term.id, title: "D", publicSlug: "d-lock", departments: ["EXEC"], createdById: director.id, status: "OPEN" } });
    const other = await prisma.applicant.create({ data: { cycleId: cycle.id, firstName: "O", lastName: "P", email: "op@y.edu", emailLower: "op@y.edu" } });
    const otherApp = await prisma.application.create({ data: { cycleId: cycle.id, applicantId: other.id, answers: {}, applicantType: "NEW", departmentChoices: ["EXEC"] } });
    await prisma.interview.create({ data: { applicationId: otherApp.id, departmentCode: "EXEC", createdById: director.id } });
    expect(await pendingReviewCount(["EXEC"], director.id)).toBe(1);
    // The director applies in the same cycle, signed out (no account link), by NetID.
    const mine = await prisma.applicant.create({ data: { cycleId: cycle.id, firstName: "D", lastName: "E", email: "x@else.org", emailLower: "x@else.org", netId: "DEE9" } });
    const myApp = await prisma.application.create({ data: { cycleId: cycle.id, applicantId: mine.id, answers: {}, applicantType: "NEW", departmentChoices: ["EXEC"] } });
    await prisma.interview.create({ data: { applicationId: myApp.id, departmentCode: "EXEC", createdById: director.id } });
    expect(await pendingReviewCount(["EXEC"], director.id)).toBe(0);
    // With an exception they see the cycle again, but still not their own.
    await prisma.cycleReviewException.create({ data: { cycleId: cycle.id, personId: director.id, reason: "Logistics", grantedById: director.id } });
    expect(await pendingReviewCount(["EXEC"], director.id)).toBe(1);
  });

  it("still counts an applicant a multi-department director must review when only ONE ranked department is decided", async () => {
    const term = await prisma.term.create({ data: { code: "SP26b", name: "Spring", startDate: new Date(), endDate: new Date(), status: "ACTIVE" } });
    await prisma.department.create({ data: { code: "EXEC", name: "Executive" } });
    await prisma.department.create({ data: { code: "MDIC", name: "Medical" } });
    const creator = await prisma.person.create({ data: { name: "C", status: "ACTIVE" } });
    const cycle = await prisma.recruitmentCycle.create({ data: { track: "DIRECTOR", termId: term.id, title: "D", publicSlug: "d2", departments: ["EXEC", "MDIC"], createdById: creator.id, status: "OPEN" } });
    const applicant = await prisma.applicant.create({ data: { cycleId: cycle.id, firstName: "E", lastName: "F", email: "ef2@y.edu", emailLower: "ef2@y.edu" } });
    const application = await prisma.application.create({ data: { cycleId: cycle.id, applicantId: applicant.id, answers: {}, applicantType: "NEW", departmentChoices: ["EXEC", "MDIC"] } });
    // EXEC interview decided REJECT; MDIC's interview is still pending.
    await prisma.interview.create({ data: { applicationId: application.id, departmentCode: "EXEC", decision: "REJECT", createdById: creator.id } });
    await prisma.interview.create({ data: { applicationId: application.id, departmentCode: "MDIC", createdById: creator.id } });

    // A director of BOTH EXEC and MDIC must still see this applicant (MDIC pending).
    expect(await pendingReviewCount(["EXEC", "MDIC"], creator.id)).toBe(1);
    // A director of ONLY EXEC has nothing left there.
    expect(await pendingReviewCount(["EXEC"], creator.id)).toBe(0);
    // A director of ONLY MDIC still owes the review.
    expect(await pendingReviewCount(["MDIC"], creator.id)).toBe(1);
  });
});
