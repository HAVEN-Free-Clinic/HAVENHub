import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetDb } from "@/platform/test/db";
import { prisma } from "@/platform/db";
import { AcceptanceError, RecruitmentAuthError } from "./review";
import { createInterview, updateInterview } from "./interviews";
import { decideWithoutInterview } from "./interview-decisions";
import { flaggedNoInfoSessionSummary, infoSessionStatuses, rejectFlaggedNoInfoSession } from "./info-session-flags";

const BEFORE = new Date("2026-10-05T12:00:00Z");
const AFTER = new Date("2026-10-20T12:00:00Z");

async function seed(opts: { sessions?: boolean } = {}) {
  const term = await prisma.term.create({ data: { code: "SP27", name: "Spring", startDate: new Date(), endDate: new Date(), status: "ACTIVE" } });
  await prisma.department.create({ data: { code: "EDUC", name: "Education" } });
  await prisma.department.create({ data: { code: "PEDS", name: "Pediatrics" } });
  const srr = await prisma.person.create({ data: { name: "SRR", status: "ACTIVE", netId: "srr1" } });
  const role = await prisma.role.create({ data: { name: "Rec Admin", grants: { create: [{ permission: "recruitment.review_all" }] } } });
  await prisma.roleAssignment.create({ data: { personId: srr.id, roleId: role.id } });
  const plain = await prisma.person.create({ data: { name: "Plain", status: "ACTIVE" } });
  const cycle = await prisma.recruitmentCycle.create({
    data: { track: "DIRECTOR", termId: term.id, title: "Directors", publicSlug: "d", departments: ["EDUC", "PEDS"], createdById: srr.id, status: "OPEN" },
  });
  let events: { id: string }[] = [];
  if (opts.sessions !== false) {
    events = [
      await prisma.attendanceEvent.create({
        data: { termId: term.id, cycleId: cycle.id, kind: "INFO_SESSION", title: "Info 1", startsAt: new Date("2026-10-01T22:00:00Z"), endsAt: new Date("2026-10-01T23:00:00Z") },
      }),
      // No end time: counts as an hour.
      await prisma.attendanceEvent.create({
        data: { termId: term.id, cycleId: cycle.id, kind: "INFO_SESSION", title: "Info 2", startsAt: new Date("2026-10-08T22:00:00Z") },
      }),
    ];
  }
  return { term, srr, plain, cycle, events };
}

async function mkApp(cycleId: string, name: string, opts: { personId?: string | null; type?: "NEW" | "RENEWAL"; status?: "SUBMITTED" | "WITHDRAWN"; choices?: string[] } = {}) {
  const applicant = await prisma.applicant.create({
    data: { cycleId, firstName: name, lastName: "X", email: `${name}@y.edu`, emailLower: `${name}@y.edu`, applicantPersonId: opts.personId ?? null },
  });
  return prisma.application.create({
    data: {
      cycleId,
      applicantId: applicant.id,
      answers: {},
      applicantType: opts.type ?? "NEW",
      renewalDepartment: opts.type === "RENEWAL" ? "EDUC" : null,
      departmentChoices: opts.choices ?? ["EDUC"],
      status: opts.status ?? "SUBMITTED",
      submittedAt: new Date(),
      withdrawnAt: opts.status === "WITHDRAWN" ? new Date() : null,
    },
    include: { applicant: true },
  });
}

beforeEach(async () => { await resetDb(); });
afterEach(async () => { await resetDb(); });

describe("infoSessionStatuses", () => {
  it("matches attendance by linked person and by walk-up email", async () => {
    const { cycle, events } = await seed();
    const member = await prisma.person.create({ data: { name: "Member", status: "ACTIVE" } });
    const byPerson = await mkApp(cycle.id, "linked", { personId: member.id });
    const byEmail = await mkApp(cycle.id, "walkup");
    const missed = await mkApp(cycle.id, "missed");
    await prisma.eventAttendance.create({ data: { eventId: events[0].id, personId: member.id, method: "STAFF" } });
    await prisma.eventAttendance.create({ data: { eventId: events[1].id, attendeeName: "W", attendeeEmail: "walkup@y.edu", method: "WALK_UP" } });

    const res = await infoSessionStatuses(cycle.id, [byPerson, byEmail, missed], AFTER);
    expect(res.phase).toBe("ENDED");
    expect(res.byApplicationId.get(byPerson.id)).toBe("ATTENDED");
    expect(res.byApplicationId.get(byEmail.id)).toBe("ATTENDED");
    expect(res.byApplicationId.get(missed.id)).toBe("FLAGGED");
  });

  it("reads 'not yet' before the last session has ended, and flags renewals after it", async () => {
    const { cycle } = await seed();
    const renewal = await mkApp(cycle.id, "ren", { type: "RENEWAL" });
    expect((await infoSessionStatuses(cycle.id, [renewal], BEFORE)).byApplicationId.get(renewal.id)).toBe("NOT_YET");
    expect((await infoSessionStatuses(cycle.id, [renewal], AFTER)).byApplicationId.get(renewal.id)).toBe("FLAGGED");
  });

  it("flags nobody on a cycle with no info sessions", async () => {
    const { cycle } = await seed({ sessions: false });
    const app = await mkApp(cycle.id, "ada");
    const res = await infoSessionStatuses(cycle.id, [app], AFTER);
    expect(res.phase).toBe("NONE");
    expect(res.byApplicationId.size).toBe(0);
  });
});

describe("rejectFlaggedNoInfoSession", () => {
  it("rejects every ranked department without an interview, skipping accepted, withdrawn and own rows", async () => {
    const { srr, cycle, events } = await seed();
    const flagged = await mkApp(cycle.id, "flagged", { choices: ["EDUC", "PEDS"] });
    const attended = await mkApp(cycle.id, "attended");
    await prisma.eventAttendance.create({ data: { eventId: events[0].id, attendeeName: "A", attendeeEmail: "attended@y.edu", method: "WALK_UP" } });
    const accepted = await mkApp(cycle.id, "accepted", { choices: ["EDUC", "PEDS"] });
    await decideWithoutInterview(accepted.id, "PEDS", "ACCEPT", srr.id, null);
    await mkApp(cycle.id, "withdrawn", { status: "WITHDRAWN" });
    // SRR's own application, submitted signed out: matched by NetID.
    const own = await mkApp(cycle.id, "own");
    await prisma.applicant.update({ where: { id: own.applicantId }, data: { netId: "srr1" } });

    expect(await flaggedNoInfoSessionSummary(cycle.id, AFTER)).toMatchObject({ phase: "ENDED", flagged: 3, rejectable: 2 });

    const res = await rejectFlaggedNoInfoSession(cycle.id, srr.id, { now: AFTER });
    expect(res.rejected).toBe(1);
    expect(res.skipped.map((s) => s.name).sort()).toEqual(["accepted X", "own X", "withdrawn X"]);

    const ivs = await prisma.interview.findMany({ where: { applicationId: flagged.id }, orderBy: { departmentCode: "asc" } });
    expect(ivs.map((i) => [i.departmentCode, i.decision, i.scheduledAt, i.invitedAt])).toEqual([
      ["EDUC", "REJECT", null, null],
      ["PEDS", "REJECT", null, null],
    ]);
    expect(await prisma.interview.count({ where: { applicationId: attended.id } })).toBe(0);
    expect(await prisma.interview.count({ where: { applicationId: own.id } })).toBe(0);
    // The accepted applicant's acceptance and EDUC are untouched.
    expect(await prisma.acceptance.count({ where: { applicationId: accepted.id } })).toBe(1);
    expect(await prisma.interview.count({ where: { applicationId: accepted.id, departmentCode: "EDUC" } })).toBe(0);
    // Confidential until Release: nothing was emailed.
    expect(await prisma.emailLog.count()).toBe(0);

    // Idempotent: the second press rejects nothing new. The summary is not
    // actor-aware, so SRR's own row still counts (another lead could reject it).
    expect(await flaggedNoInfoSessionSummary(cycle.id, AFTER)).toMatchObject({ rejectable: 1 });
    expect((await rejectFlaggedNoInfoSession(cycle.id, srr.id, { now: AFTER })).rejected).toBe(1);
  });

  it("leaves a department with an interview under way, or that already waitlisted, and reports it", async () => {
    const { srr, cycle } = await seed();
    const app = await mkApp(cycle.id, "busy", { choices: ["EDUC", "PEDS"] });
    const iv = await createInterview(app.id, "EDUC", srr.id);
    await updateInterview(iv.id, { scheduledAt: new Date("2026-12-04T15:00:00Z") }, srr.id);
    await decideWithoutInterview(app.id, "PEDS", "WAITLIST", srr.id, null);

    const res = await rejectFlaggedNoInfoSession(cycle.id, srr.id, { now: AFTER });
    expect(res.rejected).toBe(0);
    expect(res.skipped).toHaveLength(1);
    expect(res.skipped[0].reason).toMatch(/EDUC/);
    expect(res.skipped[0].reason).toMatch(/PEDS already decided/);
    const decisions = await prisma.interview.findMany({ where: { applicationId: app.id }, select: { departmentCode: true, decision: true }, orderBy: { departmentCode: "asc" } });
    expect(decisions).toEqual([{ departmentCode: "EDUC", decision: "PENDING" }, { departmentCode: "PEDS", decision: "WAITLIST" }]);
  });

  it("refuses before the last session ends, without review_all, and on a cycle with no sessions", async () => {
    const { srr, plain, cycle } = await seed();
    await mkApp(cycle.id, "ada");
    await expect(rejectFlaggedNoInfoSession(cycle.id, srr.id, { now: BEFORE })).rejects.toBeInstanceOf(AcceptanceError);
    await expect(rejectFlaggedNoInfoSession(cycle.id, plain.id, { now: AFTER })).rejects.toBeInstanceOf(RecruitmentAuthError);
    await prisma.attendanceEvent.deleteMany({});
    await expect(rejectFlaggedNoInfoSession(cycle.id, srr.id, { now: AFTER })).rejects.toBeInstanceOf(AcceptanceError);
    expect(await prisma.interview.count()).toBe(0);
  });

  it("can be narrowed with an extra filter", async () => {
    const { srr, cycle } = await seed();
    const keep = await mkApp(cycle.id, "keep");
    await mkApp(cycle.id, "other");
    const res = await rejectFlaggedNoInfoSession(cycle.id, srr.id, { now: AFTER, where: { id: { not: keep.id } } });
    expect(res.rejected).toBe(1);
    expect(await prisma.interview.count({ where: { applicationId: keep.id } })).toBe(0);
  });
});
