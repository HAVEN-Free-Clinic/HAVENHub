import { afterEach, beforeEach, expect, it } from "vitest";
import { resetDb } from "@/platform/test/db";
import { prisma } from "@/platform/db";
import { RecruitmentAuthError } from "./review";
import {
  createInterview, updateInterview, addPanelist, removePanelist, sendInterviewInvite,
  listInterviewsForReview, myAssignedInterviews, getInterview, InterviewError,
} from "./interviews";

async function seed(track: "DIRECTOR" | "VOLUNTEER" = "DIRECTOR") {
  const term = await prisma.term.create({ data: { code: "FA26", name: "Fall 2026", startDate: new Date(), endDate: new Date(), status: "ACTIVE" } });
  const educ = await prisma.department.create({ data: { code: "EDUC", name: "Education" } });
  const pcar = await prisma.department.create({ data: { code: "PCAR", name: "Patient Care" } });
  const director = await prisma.person.create({ data: { name: "Dir", status: "ACTIVE" } });
  await prisma.termMembership.create({ data: { personId: director.id, termId: term.id, departmentId: educ.id, kind: "DIRECTOR", status: "ACTIVE" } });
  const panelist = await prisma.person.create({ data: { name: "Panelist", status: "ACTIVE" } });
  const srr = await prisma.person.create({ data: { name: "SRR", status: "ACTIVE" } });
  const role = await prisma.role.create({ data: { name: "Rec Admin", grants: { create: [{ permission: "recruitment.review_all" }] } } });
  await prisma.roleAssignment.create({ data: { personId: srr.id, roleId: role.id } });
  const cycle = await prisma.recruitmentCycle.create({ data: { track, termId: term.id, title: "D", publicSlug: "d", departments: ["EDUC", "PCAR"], createdById: srr.id, status: "OPEN" } });
  const applicant = await prisma.applicant.create({ data: { cycleId: cycle.id, firstName: "Cand", lastName: "Idate", email: "cand@yale.edu", emailLower: "cand@yale.edu" } });
  const application = await prisma.application.create({ data: { cycleId: cycle.id, applicantId: applicant.id, answers: {}, applicantType: "NEW", departmentChoices: ["EDUC"] } });
  return { term, educ, pcar, director, panelist, srr, cycle, applicant, application };
}

beforeEach(async () => { await resetDb(); });
afterEach(async () => { await resetDb(); });

it("creates an interview for a director cycle within scope", async () => {
  const { director, application } = await seed();
  const iv = await createInterview(application.id, "EDUC", director.id);
  expect(iv.departmentCode).toBe("EDUC");
  expect(iv.decision).toBe("PENDING");
});

it("rejects creating an interview on a volunteer cycle", async () => {
  const { srr, application } = await seed("VOLUNTEER");
  await expect(createInterview(application.id, "EDUC", srr.id)).rejects.toBeInstanceOf(InterviewError);
});

it("rejects a director scheduling outside their department", async () => {
  const { director, application } = await seed();
  await expect(createInterview(application.id, "PCAR", director.id)).rejects.toBeInstanceOf(RecruitmentAuthError);
});

it("rejects a duplicate interview", async () => {
  const { director, application } = await seed();
  await createInterview(application.id, "EDUC", director.id);
  await expect(createInterview(application.id, "EDUC", director.id)).rejects.toBeInstanceOf(InterviewError);
});

it("schedules, panels, and invites; invite requires a time and stamps invitedAt + queues email", async () => {
  const { director, panelist, application } = await seed();
  const iv = await createInterview(application.id, "EDUC", director.id);
  await expect(sendInterviewInvite(iv.id, director.id)).rejects.toBeInstanceOf(InterviewError);
  await updateInterview(iv.id, { scheduledAt: new Date("2026-04-15T18:30:00Z"), zoomLink: "https://z", notes: null }, director.id);
  const p = await addPanelist(iv.id, panelist.id, true, director.id);
  expect(p.isLead).toBe(true);
  await sendInterviewInvite(iv.id, director.id);
  const after = await prisma.interview.findUniqueOrThrow({ where: { id: iv.id } });
  expect(after.invitedAt).not.toBeNull();
  const emails = await prisma.emailLog.findMany();
  expect(emails).toHaveLength(1);
  expect(emails[0].template).toBe("recruitment.interview_invite");
  await removePanelist(p.id, director.id);
  expect(await prisma.interviewPanelist.count({ where: { interviewId: iv.id } })).toBe(0);
});

it("rejects a director scheduling for a department the applicant did not rank", async () => {
  const { application, term, pcar } = await seed();
  const pcarDir = await prisma.person.create({ data: { name: "PcarDir", status: "ACTIVE" } });
  await prisma.termMembership.create({ data: { personId: pcarDir.id, termId: term.id, departmentId: pcar.id, kind: "DIRECTOR", status: "ACTIVE" } });
  // pcarDir directs PCAR (in scope) but the applicant ranked only EDUC
  await expect(createInterview(application.id, "PCAR", pcarDir.id)).rejects.toBeInstanceOf(RecruitmentAuthError);
});

it("lists interviews in scope and the panelist's assignments", async () => {
  const { director, panelist, srr, cycle, application } = await seed();
  const iv = await createInterview(application.id, "EDUC", director.id);
  await addPanelist(iv.id, panelist.id, false, director.id);
  expect((await listInterviewsForReview(cycle.id, director.id)).map((i) => i.id)).toEqual([iv.id]);
  expect((await listInterviewsForReview(cycle.id, srr.id))).toHaveLength(1);
  expect((await myAssignedInterviews(panelist.id)).map((i) => i.id)).toEqual([iv.id]);
  expect(await getInterview(iv.id)).not.toBeNull();
});
