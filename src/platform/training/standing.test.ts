import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ApplicantType, Track } from "@prisma/client";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import {
  getMakeupAccess,
  lockMakeup,
  partsComplete,
  recomputeTrainingStanding,
  recomputeTrainingStandingForTerm,
  trainingDayParts,
  type TrainingDayFacts,
} from "./standing";

const base: TrainingDayFacts = {
  track: "VOLUNTEER",
  clinical: false,
  returning: false,
  attendedMorning: false,
  attendedMockClinic: false,
  hasMockClinic: true,
  completedMakeupCourse: false,
  markedOff: false,
  passedRetiredQuiz: false,
};
const parts = (f: Partial<TrainingDayFacts>) => trainingDayParts({ ...base, ...f });

describe("trainingDayParts: the rule table ops set on 2026-09-19", () => {
  it("non-clinical, missed both: owes the morning and mock clinic", () => {
    expect(parts({})).toEqual({ morning: "OWED", mockClinic: "OWED" });
  });

  it("non-clinical, missed the morning: the online course makes it up", () => {
    expect(parts({ attendedMockClinic: true, completedMakeupCourse: true })).toEqual({
      morning: "ONLINE_COURSE",
      mockClinic: "ATTENDED",
    });
  });

  it("non-clinical, new or returning, came in the morning only: mock clinic owed until IT marks it off", () => {
    for (const returning of [false, true]) {
      expect(parts({ returning, attendedMorning: true })).toEqual({ morning: "ATTENDED", mockClinic: "OWED" });
      expect(parts({ returning, attendedMorning: true, markedOff: true })).toEqual({
        morning: "ATTENDED",
        mockClinic: "MARKED_OFF",
      });
    }
  });

  it("clinical, new: excused from the morning, owes mock clinic", () => {
    expect(parts({ clinical: true })).toEqual({ morning: "NOT_REQUIRED", mockClinic: "OWED" });
    expect(partsComplete(parts({ clinical: true, attendedMockClinic: true }))).toBe(true);
    expect(parts({ clinical: true, markedOff: true }).mockClinic).toBe("MARKED_OFF");
  });

  it("clinical, returning: owes neither", () => {
    const p = parts({ clinical: true, returning: true });
    expect(p).toEqual({ morning: "NOT_REQUIRED", mockClinic: "NOT_REQUIRED" });
    expect(partsComplete(p)).toBe(true);
  });

  it("records what actually happened even where nothing was owed", () => {
    expect(parts({ clinical: true, returning: true, attendedMorning: true, attendedMockClinic: true })).toEqual({
      morning: "ATTENDED",
      mockClinic: "ATTENDED",
    });
  });

  it("a term with no mock clinic owes none", () => {
    expect(parts({ hasMockClinic: false, attendedMorning: true })).toEqual({
      morning: "ATTENDED",
      mockClinic: "NOT_REQUIRED",
    });
  });

  it("directors keep the old rule: the morning only, no clinical waiver", () => {
    expect(parts({ track: "DIRECTOR", clinical: true, returning: true })).toEqual({
      morning: "OWED",
      mockClinic: "NOT_REQUIRED",
    });
  });

  it("keeps a retired-quiz pass, which nothing can re-derive", () => {
    expect(parts({ passedRetiredQuiz: true }).morning).toBe("QUIZ");
    // Attendance still reads first when both happened.
    expect(parts({ passedRetiredQuiz: true, attendedMorning: true }).morning).toBe("ATTENDED");
  });
});

// ---------------------------------------------------------------------------
// Against the database: the facts are read from where they really live.

async function fixture() {
  const past = await prisma.term.create({
    data: { code: "SU26", name: "Summer 2026", startDate: new Date("2026-05-01"), endDate: new Date("2026-09-26"), status: "ACTIVE" },
  });
  const term = await prisma.term.create({
    data: { code: "FA26", name: "Fall 2026", startDate: new Date("2026-10-01"), endDate: new Date("2027-01-31"), status: "PLANNING" },
  });
  const clinical = await prisma.department.create({ data: { code: "JCTP", name: "JCTP", isClinical: true } });
  const plain = await prisma.department.create({ data: { code: "PNLC", name: "PNLC" } });
  const lead = await prisma.person.create({ data: { name: "Lead", status: "ACTIVE" } });
  const cycle = await prisma.recruitmentCycle.create({
    data: {
      track: "VOLUNTEER", termId: term.id, title: "Volunteer Fall 2026", publicSlug: "fa26",
      departments: ["JCTP", "PNLC"], createdById: lead.id, status: "OPEN", isTermTraining: true,
    },
  });
  const morning = await prisma.attendanceEvent.create({
    data: { termId: term.id, cycleId: cycle.id, kind: "TRAINING", title: "Training", startsAt: new Date("2026-09-19T14:00:00Z") },
  });
  const mock = await prisma.attendanceEvent.create({
    data: { termId: term.id, cycleId: cycle.id, kind: "MOCK_CLINIC", title: "Mock Clinic", startsAt: new Date("2026-09-19T17:20:00Z") },
  });
  return { past, term, clinical, plain, lead, cycle, morning, mock };
}

type Fx = Awaited<ReturnType<typeof fixture>>;

/** A promoted volunteer: a Person, an ACTIVE membership, and the contract that
 *  links them back to an application of the given type. */
async function volunteer(fx: Fx, opts: { dept: "clinical" | "plain"; type: ApplicantType; email: string }) {
  const person = await prisma.person.create({ data: { name: opts.email, status: "ACTIVE", contactEmail: opts.email } });
  const department = opts.dept === "clinical" ? fx.clinical : fx.plain;
  await prisma.termMembership.create({
    data: { personId: person.id, termId: fx.term.id, departmentId: department.id, kind: "VOLUNTEER", status: "ACTIVE" },
  });
  const applicant = await prisma.applicant.create({
    data: { cycleId: fx.cycle.id, email: opts.email, emailLower: opts.email, firstName: "A", lastName: opts.email },
  });
  const application = await prisma.application.create({
    data: { cycleId: fx.cycle.id, applicantId: applicant.id, applicantType: opts.type, status: "SUBMITTED", answers: {} },
  });
  const acceptance = await prisma.acceptance.create({
    data: { applicationId: application.id, departmentCode: department.code, approvedById: fx.lead.id },
  });
  await prisma.onboardingContract.create({
    data: {
      acceptanceId: acceptance.id, token: `t-${opts.email}`, firstName: "A", lastName: opts.email,
      email: opts.email, status: "PROMOTED", promotedPersonId: person.id,
    },
  });
  return person;
}

async function checkIn(eventId: string, personId: string) {
  await prisma.eventAttendance.create({ data: { eventId, personId, method: "STAFF" } });
}

async function standing(personId: string, termId: string, track: Track = "VOLUNTEER") {
  return prisma.training.findUnique({ where: { personId_termId_track: { personId, termId, track } } });
}

describe("recomputeTrainingStanding", () => {
  beforeEach(async () => { await resetDb(); });
  afterEach(async () => { await resetDb(); });

  it("unblocks a new clinical volunteer who was at mock clinic but not the morning", async () => {
    const fx = await fixture();
    const p = await volunteer(fx, { dept: "clinical", type: "NEW", email: "new-clinical@x.edu" });
    await checkIn(fx.mock.id, p.id);

    const result = await recomputeTrainingStanding(prisma, { personId: p.id, termId: fx.term.id, track: "VOLUNTEER" });

    expect(result?.complete).toBe(true);
    const row = await standing(p.id, fx.term.id);
    expect(row).toMatchObject({ status: "COMPLETE", morningStatus: "NOT_REQUIRED", mockClinicStatus: "ATTENDED", completedVia: null });
  });

  it("clears a returning clinical volunteer who came to neither session", async () => {
    const fx = await fixture();
    const p = await volunteer(fx, { dept: "clinical", type: "RENEWAL", email: "ret-clinical@x.edu" });
    await recomputeTrainingStanding(prisma, { personId: p.id, termId: fx.term.id, track: "VOLUNTEER" });
    expect(await standing(p.id, fx.term.id)).toMatchObject({ status: "COMPLETE", morningStatus: "NOT_REQUIRED", mockClinicStatus: "NOT_REQUIRED" });
  });

  it("treats a transfer into a clinical department as new: mock clinic is owed", async () => {
    const fx = await fixture();
    const p = await volunteer(fx, { dept: "clinical", type: "TRANSFER", email: "transfer@x.edu" });
    await recomputeTrainingStanding(prisma, { personId: p.id, termId: fx.term.id, track: "VOLUNTEER" });
    expect(await standing(p.id, fx.term.id)).toMatchObject({ status: "PENDING", mockClinicStatus: "OWED" });
  });

  it("holds a non-clinical returner who missed mock clinic until the mark-off, and keeps the mark-off", async () => {
    const fx = await fixture();
    const p = await volunteer(fx, { dept: "plain", type: "RENEWAL", email: "ret-plain@x.edu" });
    await checkIn(fx.morning.id, p.id);
    await recomputeTrainingStanding(prisma, { personId: p.id, termId: fx.term.id, track: "VOLUNTEER" });
    expect(await standing(p.id, fx.term.id)).toMatchObject({ status: "PENDING", morningStatus: "ATTENDED", mockClinicStatus: "OWED" });

    await prisma.training.update({
      where: { personId_termId_track: { personId: p.id, termId: fx.term.id, track: "VOLUNTEER" } },
      data: { mockClinicMarkedAt: new Date(), mockClinicMarkedById: fx.lead.id, mockClinicNote: "director waived" },
    });
    await recomputeTrainingStanding(prisma, { personId: p.id, termId: fx.term.id, track: "VOLUNTEER" });
    expect(await standing(p.id, fx.term.id)).toMatchObject({
      status: "COMPLETE", mockClinicStatus: "MARKED_OFF", mockClinicNote: "director waived", completedVia: "ATTENDANCE",
    });
  });

  it("takes attendance credit back when the check-in is removed", async () => {
    const fx = await fixture();
    const p = await volunteer(fx, { dept: "plain", type: "NEW", email: "plain@x.edu" });
    await checkIn(fx.morning.id, p.id);
    await checkIn(fx.mock.id, p.id);
    await recomputeTrainingStanding(prisma, { personId: p.id, termId: fx.term.id, track: "VOLUNTEER" });
    expect((await standing(p.id, fx.term.id))?.status).toBe("COMPLETE");

    await prisma.eventAttendance.deleteMany({ where: { eventId: fx.morning.id, personId: p.id } });
    const result = await recomputeTrainingStanding(prisma, { personId: p.id, termId: fx.term.id, track: "VOLUNTEER" });
    expect(result?.changed).toBe(true);
    expect(await standing(p.id, fx.term.id)).toMatchObject({ status: "PENDING", morningStatus: "OWED", completedAt: null, completedVia: null });
  });

  it("credits the morning when the makeup course is complete for the cycle's term", async () => {
    const fx = await fixture();
    const p = await volunteer(fx, { dept: "plain", type: "NEW", email: "online@x.edu" });
    await checkIn(fx.mock.id, p.id);
    const course = await prisma.course.create({ data: { title: "Makeup", kind: "VIDEO", makeupForCycleId: fx.cycle.id } });
    await recomputeTrainingStanding(prisma, { personId: p.id, termId: fx.term.id, track: "VOLUNTEER" });
    expect((await standing(p.id, fx.term.id))?.morningStatus).toBe("OWED");

    // Progress in a DIFFERENT term does not count: the makeup is the cycle's.
    await prisma.courseProgress.create({ data: { personId: p.id, courseId: course.id, termId: fx.past.id, status: "COMPLETE", completedAt: new Date() } });
    await recomputeTrainingStanding(prisma, { personId: p.id, termId: fx.term.id, track: "VOLUNTEER" });
    expect((await standing(p.id, fx.term.id))?.morningStatus).toBe("OWED");

    await prisma.courseProgress.create({ data: { personId: p.id, courseId: course.id, termId: fx.term.id, status: "COMPLETE", completedAt: new Date() } });
    await recomputeTrainingStanding(prisma, { personId: p.id, termId: fx.term.id, track: "VOLUNTEER" });
    expect(await standing(p.id, fx.term.id)).toMatchObject({ status: "COMPLETE", morningStatus: "ONLINE_COURSE", completedVia: "ONLINE_COURSE" });
  });

  it("a volunteer in a clinical AND a non-clinical department follows the non-clinical rules", async () => {
    const fx = await fixture();
    const p = await volunteer(fx, { dept: "clinical", type: "RENEWAL", email: "dual@x.edu" });
    await prisma.termMembership.create({
      data: { personId: p.id, termId: fx.term.id, departmentId: fx.plain.id, kind: "VOLUNTEER", status: "ACTIVE" },
    });
    await recomputeTrainingStanding(prisma, { personId: p.id, termId: fx.term.id, track: "VOLUNTEER" });
    expect(await standing(p.id, fx.term.id)).toMatchObject({ morningStatus: "OWED", mockClinicStatus: "OWED" });
  });

  it("falls back to an earlier-term membership to decide returning when there is no contract", async () => {
    const fx = await fixture();
    const p = await prisma.person.create({ data: { name: "Hand added", status: "ACTIVE" } });
    await prisma.termMembership.create({ data: { personId: p.id, termId: fx.term.id, departmentId: fx.clinical.id, kind: "VOLUNTEER", status: "ACTIVE" } });
    await recomputeTrainingStanding(prisma, { personId: p.id, termId: fx.term.id, track: "VOLUNTEER" });
    expect((await standing(p.id, fx.term.id))?.mockClinicStatus).toBe("OWED");

    await prisma.termMembership.create({ data: { personId: p.id, termId: fx.past.id, departmentId: fx.clinical.id, kind: "VOLUNTEER", status: "ACTIVE" } });
    await recomputeTrainingStanding(prisma, { personId: p.id, termId: fx.term.id, track: "VOLUNTEER" });
    expect((await standing(p.id, fx.term.id))?.mockClinicStatus).toBe("NOT_REQUIRED");
  });

  it("writes nothing when the term has no designated training cycle", async () => {
    const fx = await fixture();
    const p = await volunteer(fx, { dept: "plain", type: "NEW", email: "none@x.edu" });
    await prisma.recruitmentCycle.update({ where: { id: fx.cycle.id }, data: { isTermTraining: false } });
    expect(await recomputeTrainingStanding(prisma, { personId: p.id, termId: fx.term.id, track: "VOLUNTEER" })).toBeNull();
    expect(await standing(p.id, fx.term.id)).toBeNull();
  });

  it("recomputes a whole term without touching rows that do not move", async () => {
    const fx = await fixture();
    const settled = await volunteer(fx, { dept: "clinical", type: "RENEWAL", email: "settled@x.edu" });
    await recomputeTrainingStandingForTerm(fx.term.id, "VOLUNTEER");
    const before = await standing(settled.id, fx.term.id);

    const again = await recomputeTrainingStandingForTerm(fx.term.id, "VOLUNTEER");

    expect(again).toEqual({ people: 1, nowComplete: 0, nowPending: 0 });
    // Same row, not rewritten: updatedAt is what a needless write would move.
    expect((await standing(settled.id, fx.term.id))?.updatedAt).toEqual(before?.updatedAt);
  });

  it("recomputes a whole term and reports who flipped", async () => {
    const fx = await fixture();
    const a = await volunteer(fx, { dept: "clinical", type: "RENEWAL", email: "a@x.edu" });
    const b = await volunteer(fx, { dept: "plain", type: "NEW", email: "b@x.edu" });
    // b was credited COMPLETE by the old morning-only rule and never went to mock clinic.
    await checkIn(fx.morning.id, b.id);
    await prisma.training.create({
      data: { personId: b.id, termId: fx.term.id, cycleId: fx.cycle.id, track: "VOLUNTEER", status: "COMPLETE", completedVia: "ATTENDANCE", morningStatus: "ATTENDED", completedAt: new Date() },
    });

    const r = await recomputeTrainingStandingForTerm(fx.term.id, "VOLUNTEER");

    expect(r).toEqual({ people: 2, nowComplete: 1, nowPending: 1 });
    expect((await standing(a.id, fx.term.id))?.status).toBe("COMPLETE");
    expect(await standing(b.id, fx.term.id)).toMatchObject({ status: "PENDING", mockClinicStatus: "OWED" });
  });
});

describe("getMakeupAccess / lockMakeup", () => {
  beforeEach(async () => { await resetDb(); });
  afterEach(async () => { await resetDb(); });

  it("is OWED only to a member whose morning is owed, DONE once the course credits it", async () => {
    const fx = await fixture();
    const owes = await volunteer(fx, { dept: "plain", type: "NEW", email: "owes@x.edu" });
    const attended = await volunteer(fx, { dept: "plain", type: "NEW", email: "came@x.edu" });
    const clinical = await volunteer(fx, { dept: "clinical", type: "NEW", email: "clin@x.edu" });
    await checkIn(fx.morning.id, attended.id);
    const stranger = await prisma.person.create({ data: { name: "Stranger", status: "ACTIVE" } });

    // No row yet for anyone: access computes it rather than guessing.
    expect(await getMakeupAccess(owes.id, fx.cycle.id)).toMatchObject({ status: "OWED", termId: fx.term.id, track: "VOLUNTEER", locked: false });
    expect((await getMakeupAccess(attended.id, fx.cycle.id)).status).toBe("NOT_OWED");
    expect((await getMakeupAccess(clinical.id, fx.cycle.id)).status).toBe("NOT_OWED");
    expect((await getMakeupAccess(stranger.id, fx.cycle.id)).status).toBe("NOT_OWED");

    const course = await prisma.course.create({ data: { title: "Makeup", kind: "VIDEO", makeupForCycleId: fx.cycle.id } });
    await prisma.courseProgress.create({ data: { personId: owes.id, courseId: course.id, termId: fx.term.id, status: "COMPLETE", completedAt: new Date() } });
    await recomputeTrainingStanding(prisma, { personId: owes.id, termId: fx.term.id, track: "VOLUNTEER" });
    expect((await getMakeupAccess(owes.id, fx.cycle.id)).status).toBe("DONE");
  });

  it("locks, and a later completion unlocks", async () => {
    const fx = await fixture();
    const p = await volunteer(fx, { dept: "plain", type: "NEW", email: "lock@x.edu" });
    await lockMakeup(prisma, p.id, fx.cycle.id);
    expect((await getMakeupAccess(p.id, fx.cycle.id)).locked).toBe(true);

    await checkIn(fx.morning.id, p.id);
    await checkIn(fx.mock.id, p.id);
    await recomputeTrainingStanding(prisma, { personId: p.id, termId: fx.term.id, track: "VOLUNTEER" });
    expect((await standing(p.id, fx.term.id))?.locked).toBe(false);
  });
});
