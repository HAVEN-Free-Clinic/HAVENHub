import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetDb } from "@/platform/test/db";
import { prisma } from "@/platform/db";
import * as render from "../email/render";
import { RecruitmentAuthError } from "./review";
import { createInterview, sendInterviewInvite, updateInterview, InterviewError } from "./interviews";
import { decideInterview, decideWithoutInterview } from "./interview-decisions";
import { releaseDecisions, sendRejections, sendAcceptanceEmail, rejectionSummary } from "./decisions";
import { sendWaitlistEmails, waitlistEmailSummary } from "./waitlist-emails";
import { assessmentHoldSummary, sendAssessmentHolds } from "./assessment-holds";

/**
 * Director-track decisions end to end: deciding with or without an interview,
 * Release, and the three applicant emails that key off those decisions.
 *
 * EDUC and PEDS are ordinary departments; INTP assesses language before it
 * accepts, which is what the assessment-hold send is for.
 */
async function seed() {
  const term = await prisma.term.create({ data: { code: "SP27", name: "Spring", startDate: new Date(), endDate: new Date(), status: "ACTIVE" } });
  const educ = await prisma.department.create({ data: { code: "EDUC", name: "Education" } });
  await prisma.department.create({ data: { code: "PEDS", name: "Pediatrics" } });
  await prisma.department.create({ data: { code: "INTP", name: "Interpreting", assessLanguageBeforeAcceptance: true } });
  const srr = await prisma.person.create({ data: { name: "SRR", status: "ACTIVE" } });
  const role = await prisma.role.create({ data: { name: "Rec Admin", grants: { create: [{ permission: "recruitment.review_all" }] } } });
  await prisma.roleAssignment.create({ data: { personId: srr.id, roleId: role.id } });
  // An EDUC director: may decide EDUC, nothing else.
  const director = await prisma.person.create({ data: { name: "Dir", status: "ACTIVE" } });
  await prisma.termMembership.create({ data: { personId: director.id, termId: term.id, departmentId: educ.id, kind: "DIRECTOR", status: "ACTIVE" } });
  const cycle = await prisma.recruitmentCycle.create({
    data: { track: "DIRECTOR", termId: term.id, title: "Directors SP27", publicSlug: "dsp27", departments: ["EDUC", "PEDS", "INTP"], createdById: srr.id, status: "OPEN" },
  });
  return { srr, director, cycle };
}

async function mkApp(cycleId: string, name: string, opts: { choices?: string[]; renewal?: string; languages?: string[] } = {}) {
  const applicant = await prisma.applicant.create({
    data: { cycleId, firstName: name, lastName: "X", email: `${name}@y.edu`, emailLower: `${name}@y.edu` },
  });
  return prisma.application.create({
    data: {
      cycleId,
      applicantId: applicant.id,
      answers: {},
      applicantType: opts.renewal ? "RENEWAL" : "NEW",
      renewalDepartment: opts.renewal ?? null,
      departmentChoices: opts.choices ?? (opts.renewal ? [opts.renewal] : ["EDUC"]),
      languagesClaimed: opts.languages ?? [],
      status: "SUBMITTED",
      submittedAt: new Date(),
    },
  });
}

const mails = (template: string) => prisma.emailLog.findMany({ where: { template }, orderBy: { toEmail: "asc" } });

beforeEach(async () => { await resetDb(); });
afterEach(async () => {
  vi.restoreAllMocks();
  await resetDb();
});

describe("decideWithoutInterview", () => {
  it("records the decision on an unscheduled, uninvited Interview row and mints the Acceptance on ACCEPT", async () => {
    const { director, cycle } = await seed();
    const app = await mkApp(cycle.id, "ada", { renewal: "EDUC" });

    const iv = await decideWithoutInterview(app.id, "EDUC", "ACCEPT", director.id, "strong renewal");

    expect(iv.decision).toBe("ACCEPT");
    expect(iv.scheduledAt).toBeNull();
    expect(iv.invitedAt).toBeNull();
    expect(iv.decidedById).toBe(director.id);
    expect(await prisma.acceptance.count({ where: { applicationId: app.id, departmentCode: "EDUC" } })).toBe(1);
    // Nothing reaches the applicant at decision time: no invite, no outcome.
    expect(await prisma.emailLog.count()).toBe(0);
  });

  it("reuses an existing unscheduled row and lets the decision be changed", async () => {
    const { director, cycle } = await seed();
    const app = await mkApp(cycle.id, "ada");
    const created = await createInterview(app.id, "EDUC", director.id);

    const first = await decideWithoutInterview(app.id, "EDUC", "ACCEPT", director.id, null);
    expect(first.id).toBe(created.id);
    const second = await decideWithoutInterview(app.id, "EDUC", "REJECT", director.id, null);
    expect(second.decision).toBe("REJECT");
    // decideInterview's teardown ran: the unemailed acceptance is gone.
    expect(await prisma.acceptance.count({ where: { applicationId: app.id } })).toBe(0);
    expect(await prisma.interview.count({ where: { applicationId: app.id } })).toBe(1);
  });

  it("refuses when the department already has an interview under way", async () => {
    const { director, cycle } = await seed();
    const app = await mkApp(cycle.id, "ada");
    const iv = await createInterview(app.id, "EDUC", director.id);
    await updateInterview(iv.id, { scheduledAt: new Date("2026-12-04T15:00:00Z") }, director.id);

    await expect(decideWithoutInterview(app.id, "EDUC", "REJECT", director.id, null)).rejects.toBeInstanceOf(InterviewError);
    expect((await prisma.interview.findUniqueOrThrow({ where: { id: iv.id } })).decision).toBe("PENDING");
  });

  it("refuses an out-of-scope decider, a self-decision, an unranked department, and a volunteer cycle, leaving no row", async () => {
    const { srr, director, cycle } = await seed();
    const app = await mkApp(cycle.id, "ada", { choices: ["EDUC", "PEDS"] });

    // EDUC director on PEDS.
    await expect(decideWithoutInterview(app.id, "PEDS", "REJECT", director.id, null)).rejects.toBeInstanceOf(RecruitmentAuthError);
    // Unranked, even for SRR.
    await expect(decideWithoutInterview(app.id, "INTP", "REJECT", srr.id, null)).rejects.toBeInstanceOf(InterviewError);
    // Their own application.
    await prisma.applicant.update({ where: { id: app.applicantId }, data: { applicantPersonId: director.id } });
    await expect(decideWithoutInterview(app.id, "EDUC", "ACCEPT", director.id, null)).rejects.toBeInstanceOf(RecruitmentAuthError);
    expect(await prisma.interview.count()).toBe(0);

    const vol = await prisma.recruitmentCycle.create({
      data: { track: "VOLUNTEER", termId: cycle.termId, title: "V", publicSlug: "v", departments: ["EDUC"], createdById: srr.id, status: "OPEN" },
    });
    const volApp = await mkApp(vol.id, "bo");
    await expect(decideWithoutInterview(volApp.id, "EDUC", "REJECT", srr.id, null)).rejects.toBeInstanceOf(InterviewError);
    expect(await prisma.interview.count()).toBe(0);
  });

  it("refuses a decider whose own application carries no account link but matches their NetID or email (#889)", async () => {
    const { director, cycle } = await seed();
    await prisma.person.update({ where: { id: director.id }, data: { netId: "dir42", contactEmail: "dir@personal.com" } });

    const byNetId = await mkApp(cycle.id, "signedout1");
    await prisma.applicant.update({ where: { id: byNetId.applicantId }, data: { applicantPersonId: null, netId: "DIR42" } });
    await expect(decideWithoutInterview(byNetId.id, "EDUC", "ACCEPT", director.id, null)).rejects.toBeInstanceOf(RecruitmentAuthError);

    const byEmail = await mkApp(cycle.id, "signedout2");
    await prisma.applicant.update({ where: { id: byEmail.applicantId }, data: { applicantPersonId: null, email: "dir@personal.com", emailLower: "dir@personal.com" } });
    await expect(decideWithoutInterview(byEmail.id, "EDUC", "ACCEPT", director.id, null)).rejects.toBeInstanceOf(RecruitmentAuthError);

    expect(await prisma.interview.count()).toBe(0);
    expect(await prisma.acceptance.count()).toBe(0);
  });

  it("never lets the row acquire a time or an invite afterwards", async () => {
    const { director, cycle } = await seed();
    const app = await mkApp(cycle.id, "ada");
    const iv = await decideWithoutInterview(app.id, "EDUC", "REJECT", director.id, null);

    await expect(updateInterview(iv.id, { scheduledAt: new Date() }, director.id)).rejects.toBeInstanceOf(InterviewError);
    // Notes and links still save.
    await updateInterview(iv.id, { scheduledAt: null, notes: "decided at the board meeting" }, director.id);
    await expect(sendInterviewInvite(iv.id, director.id)).rejects.toBeInstanceOf(InterviewError);
    expect(await mails("recruitment.interview_invite")).toHaveLength(0);
  });
});

describe("Release and the decision emails on a director cycle", () => {
  it("releases an acceptance decided without interview, then rejects a never-interviewed applicant", async () => {
    const { srr, director, cycle } = await seed();
    const accepted = await mkApp(cycle.id, "acc", { renewal: "EDUC" });
    const rejected = await mkApp(cycle.id, "rej", { renewal: "EDUC" });
    await decideWithoutInterview(accepted.id, "EDUC", "ACCEPT", director.id, null);
    await decideWithoutInterview(rejected.id, "EDUC", "REJECT", director.id, null);

    expect((await rejectionSummary(cycle.id)).rejected).toBe(1);
    const rel = await releaseDecisions(cycle.id, srr.id);
    expect(rel.sent).toBe(1);
    expect((await mails("recruitment.acceptance")).map((m) => m.toEmail)).toEqual(["acc@y.edu"]);

    expect((await sendRejections(cycle.id, srr.id)).sent).toBe(1);
    expect((await mails("recruitment.rejection")).map((m) => m.toEmail)).toEqual(["rej@y.edu"]);
  });

  it("holds a rejection back while another ranked department is still PENDING", async () => {
    const { srr, cycle } = await seed();
    const app = await mkApp(cycle.id, "two", { choices: ["EDUC", "PEDS"] });
    await decideWithoutInterview(app.id, "EDUC", "REJECT", srr.id, null);
    await createInterview(app.id, "PEDS", srr.id);
    await releaseDecisions(cycle.id, srr.id);

    expect((await sendRejections(cycle.id, srr.id)).sent).toBe(0);
    await decideWithoutInterview(app.id, "PEDS", "REJECT", srr.id, null);
    expect((await sendRejections(cycle.id, srr.id)).sent).toBe(1);
  });

  it("does not send a rejection when an interview flips REJECT -> WAITLIST between load and claim", async () => {
    const { srr, cycle } = await seed();
    const app = await mkApp(cycle.id, "flip");
    const iv = await decideWithoutInterview(app.id, "EDUC", "REJECT", srr.id, null);
    await releaseDecisions(cycle.id, srr.id);

    // resolveCycleEmail runs after the candidates were loaded and before any
    // claim, so a decision made here lands exactly in that gap.
    const real = render.resolveCycleEmail;
    vi.spyOn(render, "resolveCycleEmail").mockImplementationOnce(async (...args) => {
      await prisma.interview.update({ where: { id: iv.id }, data: { decision: "WAITLIST" } });
      return real(...args);
    });
    expect((await sendRejections(cycle.id, srr.id)).sent).toBe(0);
    expect(await mails("recruitment.rejection")).toHaveLength(0);
    expect((await prisma.application.findUniqueOrThrow({ where: { id: app.id } })).rejectionEmailedAt).toBeNull();
  });

  it("emails a director-track waitlist once, and not if the interview flips to REJECT before the claim", async () => {
    const { srr, cycle } = await seed();
    const wait = await mkApp(cycle.id, "wait");
    const flip = await mkApp(cycle.id, "zflip");
    await decideWithoutInterview(wait.id, "EDUC", "WAITLIST", srr.id, null);
    const flipIv = await decideWithoutInterview(flip.id, "EDUC", "WAITLIST", srr.id, null);
    await releaseDecisions(cycle.id, srr.id);
    expect((await waitlistEmailSummary(cycle.id)).waitlisted).toBe(2);

    const real = render.resolveCycleEmail;
    vi.spyOn(render, "resolveCycleEmail").mockImplementationOnce(async (...args) => {
      await prisma.interview.update({ where: { id: flipIv.id }, data: { decision: "REJECT" } });
      return real(...args);
    });
    expect((await sendWaitlistEmails(cycle.id, srr.id)).sent).toBe(1);
    expect((await mails("recruitment.waitlist")).map((m) => m.toEmail)).toEqual(["wait@y.edu"]);
    expect((await sendWaitlistEmails(cycle.id, srr.id)).sent).toBe(0);
  });

  it("promotes a director-track waitlist to an emailed acceptance", async () => {
    const { srr, director, cycle } = await seed();
    const app = await mkApp(cycle.id, "promo");
    const iv = await decideWithoutInterview(app.id, "EDUC", "WAITLIST", director.id, null);
    await releaseDecisions(cycle.id, srr.id);
    expect(await mails("recruitment.acceptance")).toHaveLength(0);

    // The waitlist page's promote: decideInterview(ACCEPT) then sendAcceptanceEmail.
    const promoted = await decideInterview(iv.id, "ACCEPT", director.id, null);
    expect(await sendAcceptanceEmail(promoted.applicationId, promoted.departmentCode)).toEqual({ sent: true });
    expect((await mails("recruitment.acceptance")).map((m) => m.toEmail)).toEqual(["promo@y.edu"]);
    // A later Release does not send it again.
    expect((await releaseDecisions(cycle.id, srr.id)).sent).toBe(0);
  });
});

describe("assessment holds on a director cycle", () => {
  it("holds a director applicant waitlisted on an interview while their language evaluation is outstanding", async () => {
    const { srr, cycle } = await seed();
    const held = await mkApp(cycle.id, "held", { choices: ["INTP"], languages: ["ar"] });
    const accepted = await mkApp(cycle.id, "elsewhere", { choices: ["INTP", "EDUC"], languages: ["ar"] });
    await decideWithoutInterview(held.id, "INTP", "WAITLIST", srr.id, null);
    // Waitlisted by INTP but accepted by EDUC: not on hold.
    await decideWithoutInterview(accepted.id, "INTP", "WAITLIST", srr.id, null);
    await decideWithoutInterview(accepted.id, "EDUC", "ACCEPT", srr.id, null);

    expect(await assessmentHoldSummary(cycle.id)).toEqual({ onHold: 1, unnotified: 1, emailed: 0 });
    expect((await sendAssessmentHolds(cycle.id, srr.id)).sent).toBe(1);
    expect((await mails("recruitment.assessment_hold")).map((m) => m.toEmail)).toEqual(["held@y.edu"]);
    expect((await sendAssessmentHolds(cycle.id, srr.id)).sent).toBe(0);
  });

  it("does not send a hold when the waitlist flips to REJECT before the claim", async () => {
    const { srr, cycle } = await seed();
    const app = await mkApp(cycle.id, "held", { choices: ["INTP"], languages: ["ar"] });
    const iv = await decideWithoutInterview(app.id, "INTP", "WAITLIST", srr.id, null);

    const real = render.resolveCycleEmail;
    vi.spyOn(render, "resolveCycleEmail").mockImplementationOnce(async (...args) => {
      await prisma.interview.update({ where: { id: iv.id }, data: { decision: "REJECT" } });
      return real(...args);
    });
    expect((await sendAssessmentHolds(cycle.id, srr.id)).sent).toBe(0);
    expect(await mails("recruitment.assessment_hold")).toHaveLength(0);
  });
});
