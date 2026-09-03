/**
 * Integration tests for event attendance.
 *
 * The three cases inherited from the removed recordAttendance (idempotency,
 * director-in-scope may record, unrelated person may not) are here, plus the
 * behavior that function could not express: checking in someone who has not
 * onboarded, and capturing a walk-up with no Person at all.
 *
 * Email assertions read EmailLog.template, matching reminders.test.ts.
 */

import { afterEach, beforeEach, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { RecruitmentAuthError } from "./review";
import {
  AttendanceEventError,
  createEvent,
  deleteEvent,
  ensureTrainingEventForCycle,
  getEventDetail,
  linkAttendanceByEmail,
  linkAttendee,
  listCheckInCandidates,
  recordEventCheckIn,
  relinkUnlinkedAttendance,
  removeEventCheckIn,
} from "./attendance-events";
import { completeTraining, resolveTrainingState } from "./training";

const START = new Date("2026-08-20T22:00:00.000Z");

async function seed() {
  const term = await prisma.term.create({
    data: {
      code: "FA26",
      name: "Fall 2026",
      startDate: new Date("2026-08-01T12:00:00.000Z"),
      endDate: new Date("2026-12-15T12:00:00.000Z"),
      status: "ACTIVE",
    },
  });
  const deptA = await prisma.department.create({ data: { code: "SRHD", name: "SRHD" } });
  const deptB = await prisma.department.create({ data: { code: "INTP", name: "Interpreting" } });

  // Clinic-wide recruitment lead: manage_cycles + review_all.
  const lead = await prisma.person.create({ data: { name: "Lead", status: "ACTIVE" } });
  const leadRole = await prisma.role.create({
    data: {
      name: "Rec Admin",
      grants: { create: [{ permission: "recruitment.manage_cycles" }, { permission: "recruitment.review_all" }] },
    },
  });
  await prisma.roleAssignment.create({ data: { personId: lead.id, roleId: leadRole.id } });

  // Door staffer: the new unscoped permission and nothing else.
  const door = await prisma.person.create({ data: { name: "Door", status: "ACTIVE" } });
  const doorRole = await prisma.role.create({
    data: { name: "Door", grants: { create: [{ permission: "recruitment.record_attendance" }] } },
  });
  await prisma.roleAssignment.create({ data: { personId: door.id, roleId: doorRole.id } });

  const outsider = await prisma.person.create({ data: { name: "Nobody", status: "ACTIVE" } });

  const cycle = await prisma.recruitmentCycle.create({
    data: {
      track: "VOLUNTEER",
      termId: term.id,
      title: "Fall 2026 Volunteers",
      publicSlug: "fa26-vol",
      departments: ["SRHD"],
      createdById: lead.id,
      status: "OPEN",
      inPersonTrainingDate: new Date("2026-08-20T12:00:00.000Z"),
      trainingLocation: "SHM L110",
    },
  });

  return { term, deptA, deptB, lead, door, outsider, cycle };
}

/** A member of deptA with an ACTIVE volunteer membership. */
async function seedMember(
  termId: string,
  departmentId: string,
  name: string,
  email: string | null = null,
) {
  const person = await prisma.person.create({
    data: { name, status: "ACTIVE", contactEmail: email },
  });
  await prisma.termMembership.create({
    data: { personId: person.id, termId, departmentId, kind: "VOLUNTEER", status: "ACTIVE" },
  });
  return person;
}

/** A director of deptA: a review scope, but no recruitment permission. */
async function seedDirector(termId: string, departmentId: string) {
  const person = await prisma.person.create({ data: { name: "Dir", status: "ACTIVE" } });
  await prisma.termMembership.create({
    data: { personId: person.id, termId, departmentId, kind: "DIRECTOR", status: "ACTIVE" },
  });
  return person;
}

async function trainingEvent(cycleId: string, actorId: string) {
  return ensureTrainingEventForCycle(cycleId, actorId);
}

beforeEach(async () => {
  await resetDb();
});
afterEach(async () => {
  await resetDb();
});

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

it("creates an event and refuses a training event with no cycle", async () => {
  const { term, lead } = await seed();
  const event = await createEvent(
    {
      termId: term.id,
      cycleId: null,
      kind: "INFO_SESSION",
      title: "  Fall info session  ",
      startsAt: START,
      endsAt: null,
      location: "  SHM L110  ",
      notes: null,
    },
    lead.id,
  );
  expect(event.title).toBe("Fall info session");
  expect(event.location).toBe("SHM L110");

  await expect(
    createEvent(
      { termId: term.id, cycleId: null, kind: "TRAINING", title: "T", startsAt: START, endsAt: null, location: null, notes: null },
      lead.id,
    ),
  ).rejects.toBeInstanceOf(AttendanceEventError);
});

it("creating an event requires manage_cycles", async () => {
  const { term, door } = await seed();
  await expect(
    createEvent(
      { termId: term.id, cycleId: null, kind: "OTHER", title: "T", startsAt: START, endsAt: null, location: null, notes: null },
      door.id,
    ),
  ).rejects.toBeInstanceOf(RecruitmentAuthError);
});

it("ensureTrainingEventForCycle is idempotent and seeds from the cycle", async () => {
  const { cycle, lead } = await seed();
  const first = await trainingEvent(cycle.id, lead.id);
  const second = await trainingEvent(cycle.id, lead.id);
  expect(second.id).toBe(first.id);
  expect(first.kind).toBe("TRAINING");
  expect(first.location).toBe("SHM L110");
  expect(first.startsAt.toISOString()).toBe("2026-08-20T12:00:00.000Z");
  expect(await prisma.attendanceEvent.count({ where: { cycleId: cycle.id } })).toBe(1);
});

it("refuses to delete an event that already has attendance", async () => {
  const { term, deptA, cycle, lead } = await seed();
  const member = await seedMember(term.id, deptA.id, "Vol");
  const event = await trainingEvent(cycle.id, lead.id);
  await recordEventCheckIn(event.id, { kind: "person", personId: member.id }, lead.id);
  await expect(deleteEvent(event.id, lead.id)).rejects.toBeInstanceOf(AttendanceEventError);
});

// ---------------------------------------------------------------------------
// Check-in
// ---------------------------------------------------------------------------

it("check-in is idempotent: a second tap writes no second row and sends no second email", async () => {
  const { term, deptA, cycle, lead } = await seed();
  const member = await seedMember(term.id, deptA.id, "Vol", "vol@yale.edu");
  const event = await trainingEvent(cycle.id, lead.id);

  const first = await recordEventCheckIn(event.id, { kind: "person", personId: member.id }, lead.id);
  expect(first.alreadyCheckedIn).toBe(false);
  const second = await recordEventCheckIn(event.id, { kind: "person", personId: member.id }, lead.id);
  expect(second.alreadyCheckedIn).toBe(true);

  expect(await prisma.eventAttendance.count({ where: { eventId: event.id } })).toBe(1);
  expect(await prisma.emailLog.count({ where: { template: "attendance-nudge" } })).toBe(1);
});

it("a TRAINING check-in completes training for someone who has NOT onboarded", async () => {
  const { term, cycle, lead } = await seed();
  // No TermMembership at all: an accepted applicant whose onboarding contract has
  // not been submitted, which is exactly who the old roster button could not reach.
  const notOnboarded = await prisma.person.create({
    data: { name: "Not Onboarded", status: "ACTIVE", contactEmail: "new@yale.edu" },
  });
  const event = await trainingEvent(cycle.id, lead.id);

  const result = await recordEventCheckIn(
    event.id,
    { kind: "person", personId: notOnboarded.id },
    lead.id,
  );

  expect(result.trainingCredited).toBe(true);
  expect(await resolveTrainingState(notOnboarded.id, term.id, "VOLUNTEER")).toBe("COMPLETE");
  // And they are told why it will not count yet.
  expect(result.blockers).toContain(
    "Submit your onboarding contract, which is what adds you to the roster",
  );
  const email = await prisma.emailLog.findFirstOrThrow({ where: { template: "attendance-nudge" } });
  expect(email.toEmail).toBe("new@yale.edu");
});

it("a fully cleared member gets no nudge and the row starts resolved", async () => {
  const { term, deptA, cycle, lead } = await seed();
  const member = await seedMember(term.id, deptA.id, "Cleared", "cleared@yale.edu");
  await prisma.person.update({
    where: { id: member.id },
    data: { phone: "203-555-0000" },
  });
  await prisma.hipaaCertificate.create({
    data: {
      personId: member.id,
      fileName: "c.pdf",
      storedName: "c.pdf",
      size: 1,
      mimeType: "application/pdf",
      // Well inside the term bar (termEnd + 30d), so this reads COMPLIANT.
      completionDate: new Date("2026-08-01T12:00:00.000Z"),
      verifiedAt: new Date("2026-08-02T12:00:00.000Z"),
    },
  });
  const event = await trainingEvent(cycle.id, lead.id);

  const result = await recordEventCheckIn(
    event.id,
    { kind: "person", personId: member.id },
    lead.id,
  );

  // The training task is the one thing outstanding at the moment of the read, and
  // this very check-in satisfies it -- so the only blockers that can remain are
  // other requirements. This member has none.
  expect(result.blockers.filter((b) => !b.includes("training"))).toEqual([]);
  expect(await prisma.emailLog.count({ where: { template: "attendance-nudge" } })).toBe(0);
  const row = await prisma.eventAttendance.findFirstOrThrow({ where: { eventId: event.id } });
  expect(row.resolvedAt).not.toBeNull();
});

it("captures a walk-up with no Person, then links it and backfills training", async () => {
  const { term, cycle, lead } = await seed();
  const event = await trainingEvent(cycle.id, lead.id);

  const result = await recordEventCheckIn(
    event.id,
    { kind: "walkUp", name: "  Walk Up  ", email: "  WalkUp@Yale.EDU  " },
    lead.id,
  );
  expect(result.trainingCredited).toBe(false);

  const row = await prisma.eventAttendance.findFirstOrThrow({ where: { eventId: event.id } });
  expect(row.personId).toBeNull();
  expect(row.attendeeName).toBe("Walk Up");
  // Lowercased, because it is the key the later link matches on.
  expect(row.attendeeEmail).toBe("walkup@yale.edu");
  expect(row.method).toBe("WALK_UP");

  const person = await prisma.person.create({
    data: { name: "Walk Up", status: "ACTIVE", contactEmail: "walkup@yale.edu" },
  });
  await linkAttendee(row.id, person.id, lead.id);

  const linked = await prisma.eventAttendance.findUniqueOrThrow({ where: { id: row.id } });
  expect(linked.personId).toBe(person.id);
  expect(linked.attendeeEmail).toBeNull();
  expect(await resolveTrainingState(person.id, term.id, "VOLUNTEER")).toBe("COMPLETE");
});

it("a walk-up email that already belongs to someone is linked on the spot", async () => {
  const { term, deptA, cycle, lead } = await seed();
  const member = await seedMember(term.id, deptA.id, "Known", "known@yale.edu");
  const event = await trainingEvent(cycle.id, lead.id);

  const result = await recordEventCheckIn(
    event.id,
    { kind: "walkUp", name: "Typed Wrong", email: "KNOWN@yale.edu" },
    lead.id,
  );

  expect(result.name).toBe("Known");
  const row = await prisma.eventAttendance.findFirstOrThrow({ where: { eventId: event.id } });
  expect(row.personId).toBe(member.id);
  expect(row.method).toBe("STAFF");
  expect(await resolveTrainingState(member.id, term.id, "VOLUNTEER")).toBe("COMPLETE");
});

it("rejects a walk-up with no usable email", async () => {
  const { cycle, lead } = await seed();
  const event = await trainingEvent(cycle.id, lead.id);
  await expect(
    recordEventCheckIn(event.id, { kind: "walkUp", name: "No Email", email: "nope" }, lead.id),
  ).rejects.toBeInstanceOf(AttendanceEventError);
});

// Three check-ins plus a link in one body, each of which computes clearance and
// renders an email: 3x the work of a real tap, and past the 5s default.
it("linking merges into an existing row for the same person, keeping the earlier arrival", { timeout: 20000 }, async () => {
  const { term, deptA, cycle, lead } = await seed();
  const member = await seedMember(term.id, deptA.id, "Both Ways");
  const event = await trainingEvent(cycle.id, lead.id);

  // Walk-up first (earlier), then the same human found in the search box.
  const walkUp = await recordEventCheckIn(
    event.id,
    { kind: "walkUp", name: "Both Ways", email: "both@yale.edu" },
    lead.id,
  );
  await prisma.eventAttendance.update({
    where: { id: walkUp.attendanceId },
    data: { checkedInAt: new Date("2026-08-20T21:00:00.000Z") },
  });
  const direct = await recordEventCheckIn(
    event.id,
    { kind: "person", personId: member.id },
    lead.id,
  );

  await linkAttendee(walkUp.attendanceId, member.id, lead.id);

  const rows = await prisma.eventAttendance.findMany({ where: { eventId: event.id } });
  expect(rows).toHaveLength(1);
  expect(rows[0]!.id).toBe(direct.attendanceId);
  expect(rows[0]!.checkedInAt.toISOString()).toBe("2026-08-20T21:00:00.000Z");
});

it("linkAttendanceByEmail claims prior attendance when a person is created later", async () => {
  const { term, cycle, lead } = await seed();
  const event = await trainingEvent(cycle.id, lead.id);
  await recordEventCheckIn(
    event.id,
    { kind: "walkUp", name: "Later Member", email: "later@yale.edu" },
    lead.id,
  );

  const person = await prisma.person.create({
    data: { name: "Later Member", status: "ACTIVE", contactEmail: "later@yale.edu" },
  });
  expect(await linkAttendanceByEmail(person.id, "Later@yale.edu")).toBe(1);
  expect(await resolveTrainingState(person.id, term.id, "VOLUNTEER")).toBe("COMPLETE");

  // The sweep the cron runs finds nothing left to do.
  expect(await relinkUnlinkedAttendance()).toBe(0);
});

// ---------------------------------------------------------------------------
// Authority
// ---------------------------------------------------------------------------

it("a director in scope can check in their own department's member, and nobody else", async () => {
  const { term, deptA, deptB, cycle, lead, outsider } = await seed();
  const mine = await seedMember(term.id, deptA.id, "Mine");
  const theirs = await seedMember(term.id, deptB.id, "Theirs");
  const director = await seedDirector(term.id, deptA.id);
  const event = await trainingEvent(cycle.id, lead.id);

  await recordEventCheckIn(event.id, { kind: "person", personId: mine.id }, director.id);
  expect(await resolveTrainingState(mine.id, term.id, "VOLUNTEER")).toBe("COMPLETE");

  await expect(
    recordEventCheckIn(event.id, { kind: "person", personId: theirs.id }, director.id),
  ).rejects.toBeInstanceOf(RecruitmentAuthError);
  // A walk-up is a clinic-wide assertion with no department to check it against.
  await expect(
    recordEventCheckIn(event.id, { kind: "walkUp", name: "X", email: "x@yale.edu" }, director.id),
  ).rejects.toBeInstanceOf(RecruitmentAuthError);
  await expect(
    recordEventCheckIn(event.id, { kind: "person", personId: mine.id }, outsider.id),
  ).rejects.toBeInstanceOf(RecruitmentAuthError);
});

it("recruitment.record_attendance alone is enough to check anyone in, walk-ups included", async () => {
  const { term, deptB, cycle, lead, door } = await seed();
  const other = await seedMember(term.id, deptB.id, "Other Dept");
  const event = await trainingEvent(cycle.id, lead.id);

  await recordEventCheckIn(event.id, { kind: "person", personId: other.id }, door.id);
  await recordEventCheckIn(event.id, { kind: "walkUp", name: "Guest", email: "guest@yale.edu" }, door.id);
  expect(await prisma.eventAttendance.count({ where: { eventId: event.id } })).toBe(2);
});

it("the kiosk list includes people with no membership, and a director sees only their own", async () => {
  const { term, deptA, deptB, cycle, lead, door } = await seed();
  await seedMember(term.id, deptA.id, "Mine");
  await seedMember(term.id, deptB.id, "Theirs");
  const offRoster = await prisma.person.create({
    data: { name: "Off Roster", status: "ACTIVE" },
  });
  const director = await seedDirector(term.id, deptA.id);
  const event = await trainingEvent(cycle.id, lead.id);

  const wide = await listCheckInCandidates(event.id, door.id);
  const wideOffRoster = wide.find((c) => c.personId === offRoster.id);
  expect(wideOffRoster?.offRoster).toBe(true);
  expect(wide.map((c) => c.name)).toContain("Theirs");

  const scoped = await listCheckInCandidates(event.id, director.id);
  const names = scoped.map((c) => c.name);
  expect(names).toContain("Mine");
  expect(names).not.toContain("Theirs");
  expect(names).not.toContain("Off Roster");
});

// ---------------------------------------------------------------------------
// Undo
// ---------------------------------------------------------------------------

it("undo reverses an attendance-credited training", async () => {
  const { term, deptA, cycle, lead } = await seed();
  const member = await seedMember(term.id, deptA.id, "Vol");
  const event = await trainingEvent(cycle.id, lead.id);
  const { attendanceId } = await recordEventCheckIn(
    event.id,
    { kind: "person", personId: member.id },
    lead.id,
  );

  await removeEventCheckIn(attendanceId, lead.id);

  expect(await prisma.eventAttendance.count({ where: { eventId: event.id } })).toBe(0);
  expect(await resolveTrainingState(member.id, term.id, "VOLUNTEER")).toBe("PENDING");
});

it("undo leaves a quiz-completed training alone", async () => {
  const { term, deptA, cycle, lead } = await seed();
  const member = await seedMember(term.id, deptA.id, "Quiz Passer");
  await completeTraining(prisma, {
    personId: member.id,
    termId: term.id,
    cycleId: cycle.id,
    track: "VOLUNTEER",
    via: "QUIZ",
  });
  const event = await trainingEvent(cycle.id, lead.id);
  const { attendanceId } = await recordEventCheckIn(
    event.id,
    { kind: "person", personId: member.id },
    lead.id,
  );
  // The check-in re-stamped the row as ATTENDANCE, so put it back the way a
  // member who passed the quiz and ALSO turned up would not: this test is about
  // a completion that was never the check-in's to give.
  await prisma.training.updateMany({
    where: { personId: member.id, termId: term.id, track: "VOLUNTEER" },
    data: { completedVia: "QUIZ" },
  });

  await removeEventCheckIn(attendanceId, lead.id);

  expect(await resolveTrainingState(member.id, term.id, "VOLUNTEER")).toBe("COMPLETE");
});

it("undo keeps the completion when another training attendance survives", async () => {
  const { term, deptA, cycle, lead } = await seed();
  const member = await seedMember(term.id, deptA.id, "Twice");
  const first = await trainingEvent(cycle.id, lead.id);
  const second = await createEvent(
    {
      termId: term.id,
      cycleId: cycle.id,
      kind: "TRAINING",
      title: "Makeup session",
      startsAt: new Date("2026-08-27T22:00:00.000Z"),
      endsAt: null,
      location: null,
      notes: null,
    },
    lead.id,
  );
  const a = await recordEventCheckIn(first.id, { kind: "person", personId: member.id }, lead.id);
  await recordEventCheckIn(second.id, { kind: "person", personId: member.id }, lead.id);

  await removeEventCheckIn(a.attendanceId, lead.id);

  expect(await resolveTrainingState(member.id, term.id, "VOLUNTEER")).toBe("COMPLETE");
});

// ---------------------------------------------------------------------------
// Detail view
// ---------------------------------------------------------------------------

it("the detail view offers a link suggestion for a walk-up whose email now matches", async () => {
  const { cycle, lead } = await seed();
  const event = await trainingEvent(cycle.id, lead.id);
  await recordEventCheckIn(
    event.id,
    { kind: "walkUp", name: "Suggest Me", email: "suggest@yale.edu" },
    lead.id,
  );
  const person = await prisma.person.create({
    data: { name: "Suggest Me", status: "ACTIVE", contactEmail: "Suggest@Yale.edu" },
  });

  const detail = await getEventDetail(event.id);
  expect(detail?.linkSuggestions).toHaveLength(1);
  expect(detail?.linkSuggestions[0]!.personId).toBe(person.id);
});
