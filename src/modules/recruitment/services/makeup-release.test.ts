import { afterEach, beforeEach, expect, it } from "vitest";
import { resetDb } from "@/platform/test/db";
import { prisma } from "@/platform/db";
import { recomputeTrainingStanding } from "@/platform/training/standing";
import { RecruitmentAuthError } from "./review";
import { TrainingStateError } from "./training";
import { getMakeupReleaseState, releaseMakeupTraining, runMakeupReminders, setMakeupDueDate } from "./makeup-release";

/** A designated Fall 2026 volunteer cycle whose training day has happened:
 *  a morning session and a mock clinic, both with check-ins to come. */
async function seed() {
  const term = await prisma.term.create({
    data: { code: "FA26", name: "Fall 2026", startDate: new Date("2026-10-01"), endDate: new Date("2027-01-31"), status: "PLANNING" },
  });
  const dept = await prisma.department.create({ data: { code: "PNLC", name: "Navigation" } });
  const lead = await prisma.person.create({ data: { name: "Lead", status: "ACTIVE" } });
  const role = await prisma.role.create({
    data: { name: "SRR", grants: { create: [{ permission: "recruitment.manage_cycles" }] } },
  });
  await prisma.roleAssignment.create({ data: { personId: lead.id, roleId: role.id } });
  const outsider = await prisma.person.create({ data: { name: "Nobody", status: "ACTIVE" } });
  const cycle = await prisma.recruitmentCycle.create({
    data: {
      track: "VOLUNTEER", termId: term.id, title: "Volunteer Fall 2026", publicSlug: "v",
      departments: ["PNLC"], createdById: lead.id, status: "OPEN", isTermTraining: true,
      inPersonTrainingDate: new Date("2026-09-19T12:00:00Z"),
    },
  });
  const morning = await prisma.attendanceEvent.create({
    data: { termId: term.id, cycleId: cycle.id, kind: "TRAINING", title: "Training", startsAt: new Date("2026-09-19T14:00:00Z") },
  });
  const mock = await prisma.attendanceEvent.create({
    data: { termId: term.id, cycleId: cycle.id, kind: "MOCK_CLINIC", title: "Mock clinic", startsAt: new Date("2026-09-19T17:20:00Z") },
  });
  return { term, dept, lead, outsider, cycle, morning, mock };
}

type Fx = Awaited<ReturnType<typeof seed>>;

/** A ready makeup course: active, video ready, linked to the cycle. */
async function makeupCourse(fx: Fx, opts: { ready?: boolean } = {}) {
  return prisma.course.create({
    data: {
      title: "Fall 2026 makeup", kind: "VIDEO", makeupForCycleId: fx.cycle.id,
      isActive: true, videoReady: opts.ready ?? true,
    },
  });
}

async function member(fx: Fx, name: string, opts: { morning?: boolean; mock?: boolean } = {}) {
  const person = await prisma.person.create({
    data: { name, status: "ACTIVE", legalFirstName: name, lastName: "X", contactEmail: `${name}@yale.edu` },
  });
  await prisma.termMembership.create({
    data: { personId: person.id, termId: fx.term.id, departmentId: fx.dept.id, kind: "VOLUNTEER", status: "ACTIVE" },
  });
  if (opts.morning) await prisma.eventAttendance.create({ data: { eventId: fx.morning.id, personId: person.id, method: "STAFF" } });
  if (opts.mock) await prisma.eventAttendance.create({ data: { eventId: fx.mock.id, personId: person.id, method: "STAFF" } });
  await recomputeTrainingStanding(prisma, { personId: person.id, termId: fx.term.id, track: "VOLUNTEER" });
  return person;
}

/** An accepted applicant who never submitted a contract, so has no Person. */
async function accepted(fx: Fx, name: string) {
  const applicant = await prisma.applicant.create({
    data: { cycleId: fx.cycle.id, firstName: name, lastName: "Y", email: `${name}@yale.edu`, emailLower: `${name}@yale.edu` },
  });
  const application = await prisma.application.create({
    data: { cycleId: fx.cycle.id, applicantId: applicant.id, answers: {}, applicantType: "NEW", status: "SUBMITTED" },
  });
  const acceptance = await prisma.acceptance.create({
    data: { applicationId: application.id, departmentCode: "PNLC", approvedById: fx.lead.id },
  });
  await prisma.onboardingContract.create({
    data: { acceptanceId: acceptance.id, token: `tok-${name}`, firstName: name, lastName: "Y", email: `${name}@yale.edu` },
  });
}

async function emails() {
  return prisma.emailLog.findMany({ orderBy: { createdAt: "asc" } });
}

beforeEach(async () => { await resetDb(); });
afterEach(async () => { await resetDb(); });

it("refuses to release without a ready course, and without manage_cycles", async () => {
  const fx = await seed();
  await member(fx, "absent");

  await expect(releaseMakeupTraining(fx.cycle.id, fx.lead.id)).rejects.toBeInstanceOf(TrainingStateError);
  await makeupCourse(fx, { ready: false });
  await expect(releaseMakeupTraining(fx.cycle.id, fx.lead.id)).rejects.toBeInstanceOf(TrainingStateError);
  await expect(releaseMakeupTraining(fx.cycle.id, fx.outsider.id)).rejects.toBeInstanceOf(RecruitmentAuthError);

  // Nothing was released, so the course stays invisible.
  expect((await prisma.recruitmentCycle.findUniqueOrThrow({ where: { id: fx.cycle.id } })).makeupReleasedAt).toBeNull();
  expect(await emails()).toHaveLength(0);
});

it("tells each audience the right thing, and claims each person once", async () => {
  const fx = await seed();
  await makeupCourse(fx);
  await setMakeupDueDate(fx.cycle.id, new Date("2026-10-03T12:00:00Z"), fx.lead.id);
  await member(fx, "unexcused");
  const excused = await member(fx, "excused");
  await prisma.trainingAbsenceExcuse.create({
    data: { cycleId: fx.cycle.id, personId: excused.id, reason: "Exam clash" },
  });
  await member(fx, "mockonly", { morning: true });
  await member(fx, "cleared", { morning: true, mock: true });
  await accepted(fx, "nocontract");

  const result = await releaseMakeupTraining(fx.cycle.id, fx.lead.id);

  expect(result).toMatchObject({ sent: 3, notOnboarded: 1, skipped: 0 });
  const sentTo = new Map((await emails()).map((e) => [e.toEmail, e.html]));
  expect([...sentTo.keys()].sort()).toEqual([
    "excused@yale.edu", "mockonly@yale.edu", "nocontract@yale.edu", "unexcused@yale.edu",
  ]);
  // The reprimand reaches exactly the person with no excuse on file.
  expect(sentTo.get("unexcused@yale.edu")).toContain("not acceptable");
  expect(sentTo.get("excused@yale.edu")).not.toContain("not acceptable");
  expect(sentTo.get("excused@yale.edu")).toContain("excused from training");
  // Somebody who came in the morning is chased for mock clinic only.
  expect(sentTo.get("mockonly@yale.edu")).toContain("owe mock clinic");
  expect(sentTo.get("mockonly@yale.edu")).not.toContain("Start the online makeup course");
  // No hub account yet: the contract comes first, and its link is the one to follow.
  expect(sentTo.get("nocontract@yale.edu")).toContain("submit your onboarding contract");
  expect(sentTo.get("nocontract@yale.edu")).toContain("/onboard/tok-nocontract");
  // The due date is quoted.
  expect(sentTo.get("unexcused@yale.edu")).toContain("October 3, 2026");
  // Cleared people hear nothing at all.
  expect(sentTo.has("cleared@yale.edu")).toBe(false);

  // Releasing again reaches only people the first run could not.
  const second = await releaseMakeupTraining(fx.cycle.id, fx.lead.id);
  expect(second.sent).toBe(0);
  expect((await emails()).filter((e) => e.toEmail === "unexcused@yale.edu")).toHaveLength(1);

  const state = await getMakeupReleaseState(fx.cycle.id);
  expect(state).toMatchObject({ owesMorning: 2, owesMockClinic: 3, notOnboarded: 1, emailed: 3 });
  expect(state.releasedAt).not.toBeNull();
});

it("chases only after the interval, only released cycles, and stops when they finish", async () => {
  const fx = await seed();
  await makeupCourse(fx);
  const person = await member(fx, "slow");

  // Not released: nothing is chased, however long it has been.
  expect(await runMakeupReminders()).toEqual({ sent: 0, skipped: 0 });

  await releaseMakeupTraining(fx.cycle.id, fx.lead.id);
  // The first reminder must not land the same day as the release email.
  expect((await runMakeupReminders()).sent).toBe(0);

  const fourDaysAgo = new Date(Date.now() - 4 * 86_400_000);
  const key = { personId_termId_track: { personId: person.id, termId: fx.term.id, track: "VOLUNTEER" as const } };
  await prisma.training.update({ where: key, data: { makeupEmailedAt: fourDaysAgo } });

  expect((await runMakeupReminders()).sent).toBe(1);
  const reminder = (await emails()).find((e) => e.template === "recruitment.makeup_reminder");
  expect(reminder?.toEmail).toBe("slow@yale.edu");
  expect(await prisma.training.findUniqueOrThrow({ where: key })).toMatchObject({ makeupNudgeCount: 1 });

  // Immediately again: inside the interval, so nothing goes.
  expect((await runMakeupReminders()).sent).toBe(0);

  // They finish both parts; the stream stops on its own, with no cap involved.
  await prisma.training.update({ where: key, data: { makeupNudgeLastSentAt: fourDaysAgo } });
  await prisma.eventAttendance.createMany({
    data: [
      { eventId: fx.morning.id, personId: person.id, method: "STAFF" },
      { eventId: fx.mock.id, personId: person.id, method: "STAFF" },
    ],
  });
  await recomputeTrainingStanding(prisma, { personId: person.id, termId: fx.term.id, track: "VOLUNTEER" });
  expect((await runMakeupReminders()).sent).toBe(0);
});
