import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import {
  cycleReviewLock,
  lockedCycleIds,
  grantReviewException,
  revokeReviewException,
  listReviewExceptions,
  assertCycleClear,
  CycleLockedError,
  ReviewExceptionError,
  CYCLE_LOCKED_MESSAGE,
} from "./review-lock";
import {
  listApplicantsForReview,
  canViewerOpenApplication,
  listWaitlisted,
  listReviewableCycles,
  RecruitmentAuthError,
} from "./review";
import { listInterviewsForReview, getInterview, myAssignedInterviews, createInterview, addPanelist } from "./interviews";
import { decideInterview } from "./interview-decisions";
import { submitEvaluation } from "./evaluations";
import { loadReviewApplication } from "./speed-score";
import { loadSpeedRouteBoard } from "./speed-route";
import { submitCommitteeScore, committeeScoreSummary } from "./committee-scoring";
import { getApplicantHistory } from "./history";
import { releaseSummary } from "./decisions";
import { RECRUITMENT_TOOLS, CYCLE_LOCKED, APPLICATION_REFUSAL } from "@/app/api/mcp/recruitment/tools";
import { recruitmentCycleStatusTool } from "@/app/api/mcp/tools/recruitment";

/**
 * The cycle review lock (services/review-lock.ts), end to end on a real DB:
 * the matcher, the states, the exception lifecycle, and one or more refusals in
 * every service family that reads or writes a cycle's applicants.
 */

let roleSeq = 0;
async function grant(personId: string, permissions: string[]) {
  const role = await prisma.role.create({
    data: { name: `Role-${++roleSeq}`, grants: { create: permissions.map((permission) => ({ permission })) } },
  });
  await prisma.roleAssignment.create({ data: { personId, roleId: role.id } });
}

const LEAD_PERMS = ["recruitment.access", "recruitment.manage_cycles", "recruitment.review_all", "recruitment.score"];

async function seed() {
  const term = await prisma.term.create({
    data: { code: "SP27", name: "Spring 2027", startDate: new Date(), endDate: new Date(), status: "ACTIVE" },
  });
  const exec = await prisma.department.create({ data: { code: "EXEC", name: "Executive" } });
  await prisma.department.create({ data: { code: "SRHD", name: "Student Run Health" } });

  // An ED with every recruitment permission who applies in the director cycle.
  const ed = await prisma.person.create({
    data: { name: "Eddie ED", status: "ACTIVE", netId: "ed42", contactEmail: "eddie@gmail.com" },
  });
  await grant(ed.id, LEAD_PERMS);
  // Directs EXEC too, so the department-scoped paths apply to them as well.
  await prisma.termMembership.create({ data: { personId: ed.id, termId: term.id, departmentId: exec.id, kind: "DIRECTOR", status: "ACTIVE" } });

  // Another lead who did not apply: runs the cycle and grants exceptions.
  const lead = await prisma.person.create({ data: { name: "Lena Lead", status: "ACTIVE" } });
  await grant(lead.id, LEAD_PERMS);

  const dCycle = await prisma.recruitmentCycle.create({
    data: { track: "DIRECTOR", termId: term.id, title: "Directors SP27", publicSlug: "d-sp27", departments: ["EXEC", "SRHD"], createdById: lead.id, status: "OPEN" },
  });
  const vCycle = await prisma.recruitmentCycle.create({
    data: { track: "VOLUNTEER", termId: term.id, title: "Volunteers SP27", publicSlug: "v-sp27", departments: ["EXEC", "SRHD"], createdById: lead.id, status: "OPEN" },
  });

  const mkApp = async (
    cycleId: string,
    a: { email: string; netId?: string | null; applicantPersonId?: string | null; first?: string },
    extra: Partial<{ status: "DRAFT" | "SUBMITTED" | "WITHDRAWN"; decision: "WAITLIST" | "PENDING"; routedDepartmentCode: string }> = {},
  ) => {
    const applicant = await prisma.applicant.create({
      data: {
        cycleId,
        firstName: a.first ?? "App",
        lastName: "Licant",
        email: a.email,
        emailLower: a.email.toLowerCase(),
        netId: a.netId ?? null,
        applicantPersonId: a.applicantPersonId ?? null,
      },
    });
    const app = await prisma.application.create({
      data: { cycleId, applicantId: applicant.id, answers: {}, applicantType: "NEW", departmentChoices: ["EXEC"], ...extra },
    });
    return { applicant, app };
  };

  // Someone else in the director cycle.
  const other = await mkApp(dCycle.id, { email: "olive@yale.edu", first: "Olive" });
  // The ED's own application, submitted SIGNED OUT: no account link, a NetID in
  // a different case and an address the hub does not know them by.
  const own = await mkApp(dCycle.id, { email: "ed.personal@else.org", netId: "ED42", first: "Eddie" });
  // A volunteer-cycle applicant the ED is free to see.
  const vOther = await mkApp(vCycle.id, { email: "val@yale.edu", first: "Val" }, { routedDepartmentCode: "EXEC" });

  return { term, exec, ed, lead, dCycle, vCycle, other, own, vOther, mkApp };
}

beforeEach(async () => { await resetDb(); });
afterEach(async () => { await resetDb(); });

describe("cycleReviewLock: who is matched", () => {
  it("locks on NetID alone, case-insensitively, when the application carries no account link", async () => {
    const { ed, dCycle, vCycle, own } = await seed();
    // Matched on the typed NetID alone, so the notice can say why (netIdOnly).
    expect(await cycleReviewLock(dCycle.id, ed.id)).toEqual({ state: "locked", ownApplicantIds: [own.applicant.id], netIdOnly: true });
    // Other cycles are unaffected.
    expect((await cycleReviewLock(vCycle.id, ed.id)).state).toBe("clear");
    expect(await lockedCycleIds(ed.id)).toEqual([dCycle.id]);
  });

  it("locks on the account link, the contact address, and the NetID's Yale address", async () => {
    const { vCycle, mkApp } = await seed();
    const linked = await prisma.person.create({ data: { name: "Linked", status: "ACTIVE" } });
    await mkApp(vCycle.id, { email: "whatever@x.org", applicantPersonId: linked.id });
    expect((await cycleReviewLock(vCycle.id, linked.id)).state).toBe("locked");
    // A verified identifier matched, so this is not a NetID-only lock.
    expect((await cycleReviewLock(vCycle.id, linked.id)).netIdOnly).toBeUndefined();

    const byContact = await prisma.person.create({ data: { name: "Contact", status: "ACTIVE", contactEmail: "Casey@Gmail.com" } });
    await mkApp(vCycle.id, { email: "casey@gmail.com" });
    expect((await cycleReviewLock(vCycle.id, byContact.id)).state).toBe("locked");

    const byYale = await prisma.person.create({ data: { name: "Yale", status: "ACTIVE", netId: "yy7" } });
    await mkApp(vCycle.id, { email: "yy7@yale.edu" });
    expect((await cycleReviewLock(vCycle.id, byYale.id)).state).toBe("locked");

    const stranger = await prisma.person.create({ data: { name: "Stranger", status: "ACTIVE", netId: "zz1", contactEmail: "z@z.org" } });
    expect((await cycleReviewLock(vCycle.id, stranger.id)).state).toBe("clear");
  });

  it("locks for a draft, a submission and a withdrawal alike; a discarded draft no longer locks", async () => {
    const { vCycle, mkApp } = await seed();
    for (const status of ["DRAFT", "SUBMITTED", "WITHDRAWN"] as const) {
      const p = await prisma.person.create({ data: { name: status, status: "ACTIVE", contactEmail: `${status.toLowerCase()}@p.org` } });
      const { applicant } = await mkApp(vCycle.id, { email: `${status.toLowerCase()}@p.org` }, { status });
      expect((await cycleReviewLock(vCycle.id, p.id)).state).toBe("locked");
      if (status === "DRAFT") {
        // discardDraft deletes the Applicant row (withdraw.ts), and the lock with it.
        await prisma.applicant.delete({ where: { id: applicant.id } });
        expect((await cycleReviewLock(vCycle.id, p.id)).state).toBe("clear");
      }
    }
  });

  it("never locks a test run: its applicants are made up and the team rehearses by applying", async () => {
    const { term, lead, mkApp } = await seed();
    const test = await prisma.recruitmentCycle.create({
      data: { track: "VOLUNTEER", termId: term.id, title: "Test", publicSlug: "t", departments: ["EXEC"], createdById: lead.id, status: "OPEN", isTest: true },
    });
    const p = await prisma.person.create({ data: { name: "Rehearser", status: "ACTIVE", contactEmail: "r@p.org" } });
    await mkApp(test.id, { email: "r@p.org" });
    expect((await cycleReviewLock(test.id, p.id)).state).toBe("clear");
  });
});

describe("review exceptions", () => {
  it("requires review_all, a reason, and someone other than the granter; records and audits grant and revoke", async () => {
    const { ed, lead, dCycle, own } = await seed();
    const director = await prisma.person.create({ data: { name: "Plain", status: "ACTIVE" } });
    await expect(grantReviewException(dCycle.id, ed.id, "Logistics", director.id)).rejects.toThrow(RecruitmentAuthError);
    await expect(grantReviewException(dCycle.id, ed.id, "   ", lead.id)).rejects.toThrow(ReviewExceptionError);
    await expect(grantReviewException(dCycle.id, lead.id, "Me", lead.id)).rejects.toThrow(ReviewExceptionError);

    await grantReviewException(dCycle.id, ed.id, "Schedules EXEC interviews; ED approved", lead.id);
    expect(await cycleReviewLock(dCycle.id, ed.id)).toEqual({ state: "excepted", ownApplicantIds: [own.applicant.id], netIdOnly: true });
    const [row] = await listReviewExceptions(dCycle.id);
    expect(row).toMatchObject({ personId: ed.id, reason: "Schedules EXEC interviews; ED approved", grantedByName: "Lena Lead" });
    await expect(grantReviewException(dCycle.id, ed.id, "Again", lead.id)).rejects.toThrow(ReviewExceptionError);

    await revokeReviewException(dCycle.id, ed.id, lead.id);
    expect((await cycleReviewLock(dCycle.id, ed.id)).state).toBe("locked");
    const audit = await prisma.auditLog.findMany({ where: { entityId: dCycle.id }, orderBy: { createdAt: "asc" } });
    expect(audit.map((a) => a.action)).toEqual(["recruitment.review_exception_grant", "recruitment.review_exception_revoke"]);
    expect(audit[1].before).toMatchObject({ personId: ed.id, reason: "Schedules EXEC interviews; ED approved" });
  });

  it("a lead who applied in the cycle cannot grant or revoke its exceptions", async () => {
    const { ed, dCycle } = await seed();
    const someone = await prisma.person.create({ data: { name: "Someone", status: "ACTIVE" } });
    await expect(grantReviewException(dCycle.id, someone.id, "Logistics", ed.id)).rejects.toThrow(CycleLockedError);
  });

  it("an applicant-lead holding an exception still cannot grant or revoke exceptions in that cycle", async () => {
    const { ed, lead, dCycle, mkApp } = await seed();
    await grantReviewException(dCycle.id, ed.id, "Logistics", lead.id);
    // A fellow applicant the excepted ED might want to let back in.
    const fellow = await prisma.person.create({ data: { name: "Fellow", status: "ACTIVE", netId: "fw9" } });
    await mkApp(dCycle.id, { email: "fw9@yale.edu" });
    await expect(grantReviewException(dCycle.id, fellow.id, "Logistics", ed.id)).rejects.toThrow(RecruitmentAuthError);
    await expect(revokeReviewException(dCycle.id, ed.id, ed.id)).rejects.toThrow(RecruitmentAuthError);
    expect((await cycleReviewLock(dCycle.id, fellow.id)).state).toBe("locked");
  });

  it("does not reach cycle-wide steps such as Decisions and Release", async () => {
    const { ed, lead, dCycle } = await seed();
    await expect(releaseSummary(dCycle.id, ed.id)).rejects.toThrow(CycleLockedError);
    await grantReviewException(dCycle.id, ed.id, "Logistics", lead.id);
    await expect(assertCycleClear(dCycle.id, ed.id)).rejects.toThrow(RecruitmentAuthError);
    await expect(releaseSummary(dCycle.id, ed.id)).rejects.toThrow(RecruitmentAuthError);
    await expect(releaseSummary(dCycle.id, lead.id)).resolves.toMatchObject({ acceptedApplications: 0 });
  });
});

describe("roster, detail and lists", () => {
  it("roster: locked sees nobody, excepted sees everyone but themselves, other cycles unaffected", async () => {
    const { ed, lead, dCycle, vCycle, other, own, vOther } = await seed();
    expect(await listApplicantsForReview(dCycle.id, ed.id)).toEqual([]);
    expect((await listApplicantsForReview(vCycle.id, ed.id)).map((a) => a.id)).toEqual([vOther.app.id]);
    expect((await listApplicantsForReview(dCycle.id, lead.id)).map((a) => a.id).sort()).toEqual([other.app.id, own.app.id].sort());
    await grantReviewException(dCycle.id, ed.id, "Logistics", lead.id);
    expect((await listApplicantsForReview(dCycle.id, ed.id)).map((a) => a.id)).toEqual([other.app.id]);
  });

  it("detail access: refused when locked; with an exception, everyone's but their own", async () => {
    const { ed, lead, dCycle, other, own } = await seed();
    const viewable = (a: typeof other.app) => ({ ...a, cycle: { track: "DIRECTOR" } });
    expect(await canViewerOpenApplication(viewable(other.app), ed.id)).toBe(false);
    expect(await canViewerOpenApplication(viewable(own.app), ed.id)).toBe(false);
    await grantReviewException(dCycle.id, ed.id, "Logistics", lead.id);
    expect(await canViewerOpenApplication(viewable(other.app), ed.id)).toBe(true);
    expect(await canViewerOpenApplication(viewable(own.app), ed.id)).toBe(false);
  });

  it("waitlist and reviewable cycles leave the locked cycle out", async () => {
    const { ed, lead, dCycle, other } = await seed();
    await prisma.application.update({ where: { id: other.app.id }, data: { decision: "WAITLIST", routedDepartmentCode: "EXEC" } });
    expect(await listWaitlisted(dCycle.id, ed.id)).toEqual([]);
    expect((await listWaitlisted(dCycle.id, lead.id)).map((e) => e.applicationId)).toEqual([other.app.id]);
    expect((await listReviewableCycles(ed.id)).map((c) => c.id)).not.toContain(dCycle.id);
  });

  it("history hides live applications from a locked cycle, and the viewer's own anywhere", async () => {
    const { ed, lead, dCycle, vCycle, mkApp } = await seed();
    // Olive applied to both cycles; the ED opens her volunteer record.
    await mkApp(vCycle.id, { email: "olive@yale.edu", first: "Olive" });
    const asEd = await getApplicantHistory({ emails: ["olive@yale.edu"], viewerId: ed.id });
    expect(asEd.entries.map((e) => e.cycleLabel)).toEqual(["Volunteers SP27"]);
    const asLead = await getApplicantHistory({ emails: ["olive@yale.edu"], viewerId: lead.id });
    expect(asLead.entries.map((e) => e.cycleLabel).sort()).toEqual(["Directors SP27", "Volunteers SP27"]);
    void dCycle;
  });
});

describe("interviews", () => {
  async function interviews() {
    const s = await seed();
    const ivOther = await prisma.interview.create({ data: { applicationId: s.other.app.id, departmentCode: "EXEC", createdById: s.lead.id } });
    const ivOwn = await prisma.interview.create({ data: { applicationId: s.own.app.id, departmentCode: "EXEC", createdById: s.lead.id } });
    return { ...s, ivOther, ivOwn };
  }

  it("list and detail: locked sees none; excepted sees others but never their own", async () => {
    const { ed, lead, dCycle, ivOther, ivOwn } = await interviews();
    expect(await listInterviewsForReview(dCycle.id, ed.id)).toEqual([]);
    expect(await getInterview(ivOther.id, ed.id)).toEqual({ locked: true });
    await grantReviewException(dCycle.id, ed.id, "Logistics", lead.id);
    expect((await listInterviewsForReview(dCycle.id, ed.id)).map((i) => i.id)).toEqual([ivOther.id]);
    expect(await getInterview(ivOwn.id, ed.id)).toBeNull();
    expect((await getInterview(ivOther.id, ed.id))?.locked).toBe(false);
  });

  it("My interviews drops a panel seat in a cycle the panelist applied in", async () => {
    const { ed, ivOther } = await interviews();
    await prisma.interviewPanelist.create({ data: { interviewId: ivOther.id, personId: ed.id } });
    expect(await myAssignedInterviews(ed.id)).toEqual([]);
  });

  it("writes: no scheduling or evaluating in a locked cycle; nobody added to a panel there; own refused even when excepted", async () => {
    const { ed, lead, dCycle, other, ivOther, ivOwn } = await interviews();
    await expect(createInterview(other.app.id, "SRHD", ed.id)).rejects.toThrow(CycleLockedError);
    await expect(addPanelist(ivOther.id, ed.id, false, lead.id)).rejects.toThrow("can't sit on this interview's panel");
    await prisma.interviewPanelist.create({ data: { interviewId: ivOther.id, personId: ed.id } });
    await expect(submitEvaluation(ivOther.id, ed.id, 4, null)).rejects.toThrow(CycleLockedError);

    await grantReviewException(dCycle.id, ed.id, "Logistics", lead.id);
    await expect(submitEvaluation(ivOther.id, ed.id, 4, null)).resolves.toBeTruthy();
    // Their own application, matched by NetID with no account link (#889).
    await expect(decideInterview(ivOwn.id, "ACCEPT", ed.id, null)).rejects.toThrow("You can't decide your own interview.");
    await expect(addPanelist(ivOwn.id, ed.id, false, lead.id)).rejects.toThrow("can't sit on this interview's panel");
    await prisma.interviewPanelist.create({ data: { interviewId: ivOwn.id, personId: ed.id } });
    await expect(submitEvaluation(ivOwn.id, ed.id, 5, null)).rejects.toThrow("You can't evaluate your own interview.");
    await expect(createInterview(ivOwn.applicationId, "SRHD", ed.id)).rejects.toThrow(RecruitmentAuthError);
  });
});

describe("scoring and speed review", () => {
  it("score, summary and speed-score loader refuse a locked viewer", async () => {
    // On the volunteer cycle: director cycles are not committee-scored at all,
    // so the lock is exercised where scoring actually happens.
    const { ed, lead, vCycle, vOther, mkApp } = await seed();
    await mkApp(vCycle.id, { email: "eddie@gmail.com" }, { status: "DRAFT" });
    await submitCommitteeScore(vOther.app.id, lead.id, 4, "Strong");
    await expect(submitCommitteeScore(vOther.app.id, ed.id, 5, null)).rejects.toThrow(CycleLockedError);
    expect(await committeeScoreSummary(vOther.app.id, ed.id)).toEqual({ average: null, count: 0, scores: [] });
    expect((await committeeScoreSummary(vOther.app.id, lead.id)).count).toBe(1);
    expect(await loadReviewApplication(vOther.app.id, ed.id)).toEqual({ error: CYCLE_LOCKED_MESSAGE });
  });

  it("speed route board refuses a lead who applied in the volunteer cycle", async () => {
    const { ed, lead, vCycle, mkApp } = await seed();
    await mkApp(vCycle.id, { email: "eddie@gmail.com" }, { status: "DRAFT" });
    await expect(loadSpeedRouteBoard(vCycle.id, ed.id)).rejects.toThrow(CycleLockedError);
    await expect(loadSpeedRouteBoard(vCycle.id, lead.id)).resolves.toMatchObject({ cycleId: vCycle.id });
  });
});

describe("MCP tools", () => {
  const run = (name: string, personId: string, args: Record<string, unknown> = {}) =>
    RECRUITMENT_TOOLS.find((t) => t.name === name)!.run({ personId }, args);

  it("refuse the locked cycle by name, label it in list_cycles, and hide it from the open-cycle count", async () => {
    const { ed, lead, dCycle, vCycle, other } = await seed();
    for (const name of ["cycle_summary", "list_applicants", "list_interviews", "list_waitlist"]) {
      expect(await run(name, ed.id, { cycle_id: dCycle.id })).toBe(CYCLE_LOCKED);
    }
    expect(await run("get_application", ed.id, { application_id: other.app.id })).toBe(APPLICATION_REFUSAL);
    expect(JSON.parse(await run("cycle_summary", ed.id, { cycle_id: vCycle.id })).totalSubmitted).toBe(1);
    const cycles = JSON.parse(await run("list_cycles", ed.id)).cycles as { id: string; reviewLocked?: boolean }[];
    expect(cycles.find((c) => c.id === dCycle.id)?.reviewLocked).toBe(true);
    expect(cycles.find((c) => c.id === vCycle.id)?.reviewLocked).toBeUndefined();

    const status = await recruitmentCycleStatusTool.run({ personId: ed.id }, {});
    expect(status).toContain("hidden from you because you applied");
    expect(await recruitmentCycleStatusTool.run({ personId: lead.id }, {})).not.toContain("hidden from you");
  });

  it("list_interviews admits a department director without recruitment.access", async () => {
    const { term, exec, lead, dCycle, other } = await seed();
    const director = await prisma.person.create({ data: { name: "Dee Director", status: "ACTIVE" } });
    await prisma.termMembership.create({ data: { personId: director.id, termId: term.id, departmentId: exec.id, kind: "DIRECTOR", status: "ACTIVE" } });
    await prisma.interview.create({ data: { applicationId: other.app.id, departmentCode: "EXEC", createdById: lead.id } });
    const out = JSON.parse(await run("list_interviews", director.id, { cycle_id: dCycle.id }));
    expect(out.total).toBe(1);
  });
});
