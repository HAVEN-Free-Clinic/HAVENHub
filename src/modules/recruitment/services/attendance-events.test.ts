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
  attendanceRevision,
  AttendanceEventError,
  CheckInConfirmationRequired,
  countAcceptedForCycle,
  doorSnapshot,
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
import { resolveBlockersFor } from "@/platform/compliance/attendance-blockers";

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

/**
 * Someone the clinic accepted who has NOT onboarded: an Applicant, an
 * Application and an Acceptance, and deliberately no Person -- promotion is what
 * creates that, and not having reached it yet is the whole state under test.
 */
async function seedAccepted(
  cycleId: string,
  approverId: string,
  opts: { first: string; last: string; email: string; netId?: string; deptCode?: string },
) {
  const applicant = await prisma.applicant.create({
    data: {
      cycleId,
      firstName: opts.first,
      lastName: opts.last,
      email: opts.email,
      emailLower: opts.email.toLowerCase(),
      netId: opts.netId ?? null,
    },
  });
  const application = await prisma.application.create({
    data: {
      cycleId,
      applicantId: applicant.id,
      answers: {},
      applicantType: "NEW",
      departmentChoices: [opts.deptCode ?? "SRHD"],
    },
  });
  const acceptance = await prisma.acceptance.create({
    data: {
      applicationId: application.id,
      departmentCode: opts.deptCode ?? "SRHD",
      approvedById: approverId,
    },
  });
  return { applicant, application, acceptance };
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
    { kind: "walkUp", name: "  Walk Up  ", email: "  WalkUp@Yale.EDU  ", confirmed: true },
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
    { kind: "walkUp", name: "Both Ways", email: "both@yale.edu", confirmed: true },
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
    { kind: "walkUp", name: "Later Member", email: "later@yale.edu", confirmed: true },
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
  await recordEventCheckIn(
    event.id,
    { kind: "walkUp", name: "Guest", email: "guest@yale.edu", confirmed: true },
    door.id,
  );
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
  const wideOffRoster = wide.find((c) => c.id === offRoster.id);
  expect(wideOffRoster?.offRoster).toBe(true);
  expect(wide.map((c) => c.name)).toContain("Theirs");

  const scoped = await listCheckInCandidates(event.id, director.id);
  const names = scoped.map((c) => c.name);
  expect(names).toContain("Mine");
  expect(names).not.toContain("Theirs");
  expect(names).not.toContain("Off Roster");
});

// ---------------------------------------------------------------------------
// Accepted applicants at the door
// ---------------------------------------------------------------------------

it("the door lists people accepted into the cycle who have no Person yet", async () => {
  const { cycle, lead, door } = await seed();
  await seedAccepted(cycle.id, lead.id, {
    first: "Ada",
    last: "Lovelace",
    email: "Ada.Lovelace@yale.edu",
    netId: "AL99",
  });
  const event = await trainingEvent(cycle.id, lead.id);

  const row = (await listCheckInCandidates(event.id, door.id)).find(
    (c) => c.name === "Ada Lovelace",
  );
  expect(row).toBeDefined();
  expect(row?.kind).toBe("applicant");
  expect(row?.accepted).toBe(true);
  expect(row?.offRoster).toBe(true);
  // Lowercased so the browser's exact-match compare needs no normalization of
  // its own, on either side.
  expect(row?.netId).toBe("al99");
});

it("drops an accepted applicant from the door once promotion has given them a Person", async () => {
  const { term, deptA, cycle, lead, door } = await seed();
  const { acceptance } = await seedAccepted(cycle.id, lead.id, {
    first: "Ada",
    last: "Lovelace",
    email: "ada@yale.edu",
  });
  const person = await seedMember(term.id, deptA.id, "Ada Lovelace", "ada@yale.edu");
  await prisma.onboardingContract.create({
    data: {
      acceptanceId: acceptance.id,
      token: "tok-promoted",
      email: "ada@yale.edu",
      firstName: "Ada",
      lastName: "Lovelace",
      promotedPersonId: person.id,
    },
  });
  const event = await trainingEvent(cycle.id, lead.id);

  const rows = (await listCheckInCandidates(event.id, door.id)).filter(
    (c) => c.name === "Ada Lovelace",
  );
  expect(rows).toHaveLength(1);
  expect(rows[0].kind).toBe("person");
  // Still marked accepted: they belong at this training, and the door says so.
  expect(rows[0].accepted).toBe(true);
});

it("offers one row, not two, for an applicant accepted by two departments", async () => {
  const { cycle, lead, door } = await seed();
  const { application } = await seedAccepted(cycle.id, lead.id, {
    first: "Ada",
    last: "Lovelace",
    email: "ada@yale.edu",
    deptCode: "SRHD",
  });
  await prisma.acceptance.create({
    data: { applicationId: application.id, departmentCode: "INTP", approvedById: lead.id },
  });
  const event = await trainingEvent(cycle.id, lead.id);

  const rows = (await listCheckInCandidates(event.id, door.id)).filter(
    (c) => c.name === "Ada Lovelace",
  );
  expect(rows).toHaveLength(1);
  expect(rows[0].departmentCodes.sort()).toEqual(["INTP", "SRHD"]);
});

it("hides accepted applicants from a department-scoped director", async () => {
  const { term, deptA, cycle, lead } = await seed();
  await seedAccepted(cycle.id, lead.id, { first: "Ada", last: "Lovelace", email: "ada@yale.edu" });
  const director = await seedDirector(term.id, deptA.id);
  const event = await trainingEvent(cycle.id, lead.id);

  const names = (await listCheckInCandidates(event.id, director.id)).map((c) => c.name);
  expect(names).not.toContain("Ada Lovelace");
});

it("checks in an accepted applicant as a linkable walk-up, and links it at promotion", async () => {
  const { term, deptA, cycle, lead, door } = await seed();
  const { acceptance } = await seedAccepted(cycle.id, lead.id, {
    first: "Ada",
    last: "Lovelace",
    email: "Ada.Lovelace@yale.edu",
  });
  const event = await trainingEvent(cycle.id, lead.id);

  const outcome = await recordEventCheckIn(
    event.id,
    { kind: "applicant", acceptanceId: acceptance.id },
    door.id,
  );
  expect(outcome.name).toBe("Ada Lovelace");
  // No Person, so no training credit yet -- the row is what waits for one.
  expect(outcome.trainingCredited).toBe(false);

  const row = await prisma.eventAttendance.findUniqueOrThrow({ where: { id: outcome.attendanceId } });
  expect(row.personId).toBeNull();
  expect(row.method).toBe("WALK_UP");
  // Lowercased by the writer: it is the join key linkAttendanceByEmail uses.
  expect(row.attendeeEmail).toBe("ada.lovelace@yale.edu");

  // Promotion arrives later and the attendance follows them onto the roster.
  const person = await seedMember(term.id, deptA.id, "Ada Lovelace", "ada.lovelace@yale.edu");
  await linkAttendanceByEmail(person.id, "Ada.Lovelace@yale.edu");
  const linked = await prisma.eventAttendance.findUniqueOrThrow({ where: { id: row.id } });
  expect(linked.personId).toBe(person.id);
  expect(await resolveTrainingState(person.id, term.id, "VOLUNTEER")).toBe("COMPLETE");
});

it("tells an accepted applicant to finish onboarding, not to apply", async () => {
  const { cycle, lead, door } = await seed();
  const { acceptance } = await seedAccepted(cycle.id, lead.id, {
    first: "Ada",
    last: "Lovelace",
    email: "ada@yale.edu",
  });
  const event = await trainingEvent(cycle.id, lead.id);

  const accepted = await recordEventCheckIn(
    event.id,
    { kind: "applicant", acceptanceId: acceptance.id },
    door.id,
  );
  expect(accepted.blockerKeys).toEqual(["contract"]);
  expect(accepted.blockers.join(" ")).toContain("onboarding contract");
  expect(accepted.blockers.join(" ")).not.toContain("Submit an application");
  expect(accepted.notOnAcceptedList).toBe(false);

  // The stranger beside them in the queue still gets the other message. Both
  // raise the same `contract` key, so the flag is the ONLY thing that tells the
  // door these two people owe different things.
  const stranger = await recordEventCheckIn(
    event.id,
    { kind: "walkUp", name: "Guest", email: "guest@yale.edu", confirmed: true },
    door.id,
  );
  expect(stranger.blockers.join(" ")).toContain("Submit an application");
  expect(stranger.blockerKeys).toEqual(accepted.blockerKeys);
  expect(stranger.notOnAcceptedList).toBe(true);
});

it("keeps saying a stranger owes an application when they are scanned again", async () => {
  const { cycle, lead, door } = await seed();
  const event = await trainingEvent(cycle.id, lead.id);
  const target = { kind: "walkUp" as const, name: "Guest", email: "guest@yale.edu", confirmed: true };

  await recordEventCheckIn(event.id, target, door.id);
  const second = await recordEventCheckIn(event.id, target, door.id);

  expect(second.alreadyCheckedIn).toBe(true);
  expect(second.notOnAcceptedList).toBe(true);
});

it("never flags an event with no cycle, where nobody can be off the list", async () => {
  const { term, lead, door } = await seed();
  const event = await createEvent(
    {
      termId: term.id,
      cycleId: null,
      kind: "INFO_SESSION",
      title: "Open house",
      startsAt: START,
      endsAt: null,
      location: null,
      notes: null,
    },
    lead.id,
  );

  const outcome = await recordEventCheckIn(
    event.id,
    { kind: "walkUp", name: "Prospective Person", email: "prospect@yale.edu" },
    door.id,
  );
  // An info session is where a stranger is SUPPOSED to be.
  expect(outcome.notOnAcceptedList).toBe(false);
});

it("refuses an acceptance from another cycle", async () => {
  const { term, cycle, lead, door } = await seed();
  const other = await prisma.recruitmentCycle.create({
    data: {
      track: "VOLUNTEER",
      termId: term.id,
      title: "Spring",
      publicSlug: "sp27-vol",
      departments: ["SRHD"],
      createdById: lead.id,
      status: "OPEN",
    },
  });
  const { acceptance } = await seedAccepted(other.id, lead.id, {
    first: "Ada",
    last: "Lovelace",
    email: "ada@yale.edu",
  });
  const event = await trainingEvent(cycle.id, lead.id);

  await expect(
    recordEventCheckIn(event.id, { kind: "applicant", acceptanceId: acceptance.id }, door.id),
  ).rejects.toBeInstanceOf(AttendanceEventError);
});

it("a scoped director may not check in an accepted applicant", async () => {
  const { term, deptA, cycle, lead } = await seed();
  const { acceptance } = await seedAccepted(cycle.id, lead.id, {
    first: "Ada",
    last: "Lovelace",
    email: "ada@yale.edu",
  });
  const director = await seedDirector(term.id, deptA.id);
  const event = await trainingEvent(cycle.id, lead.id);

  await expect(
    recordEventCheckIn(event.id, { kind: "applicant", acceptanceId: acceptance.id }, director.id),
  ).rejects.toBeInstanceOf(RecruitmentAuthError);
});

// ---------------------------------------------------------------------------
// The "not on the accepted list" question
// ---------------------------------------------------------------------------

it("asks before recording a walk-up nobody accepted, and records once confirmed", async () => {
  const { cycle, lead, door } = await seed();
  const event = await trainingEvent(cycle.id, lead.id);
  const target = { kind: "walkUp" as const, name: "Sam Rivera", email: "sam@yale.edu" };

  await expect(recordEventCheckIn(event.id, target, door.id)).rejects.toBeInstanceOf(
    CheckInConfirmationRequired,
  );
  // Nothing written while the question stands.
  expect(await prisma.eventAttendance.count({ where: { eventId: event.id } })).toBe(0);

  const outcome = await recordEventCheckIn(event.id, { ...target, confirmed: true }, door.id);
  expect(outcome.alreadyCheckedIn).toBe(false);
  expect(await prisma.eventAttendance.count({ where: { eventId: event.id } })).toBe(1);
});

it("does not ask about a walk-up the cycle accepted, however they were typed in", async () => {
  const { cycle, lead, door } = await seed();
  await seedAccepted(cycle.id, lead.id, {
    first: "Ada",
    last: "Lovelace",
    email: "ada@yale.edu",
  });
  const event = await trainingEvent(cycle.id, lead.id);

  // Typed by hand, in the wrong case, without touching the acceptance row.
  const outcome = await recordEventCheckIn(
    event.id,
    { kind: "walkUp", name: "Ada L", email: "ADA@yale.edu" },
    door.id,
  );
  expect(outcome.blockerKeys).toEqual(["contract"]);
});

it("does not ask about someone who has a hub account", async () => {
  const { term, deptA, cycle, lead, door } = await seed();
  await seedMember(term.id, deptA.id, "Vol", "vol@yale.edu");
  const event = await trainingEvent(cycle.id, lead.id);

  const outcome = await recordEventCheckIn(
    event.id,
    { kind: "walkUp", name: "Whoever", email: "vol@yale.edu" },
    door.id,
  );
  // Matched to their Person rather than questioned or orphaned.
  expect(outcome.name).toBe("Vol");
});

it("never asks at an event with no cycle, where there is no list to be on", async () => {
  const { term, lead, door } = await seed();
  const event = await createEvent(
    {
      termId: term.id,
      cycleId: null,
      kind: "INFO_SESSION",
      title: "Open house",
      startsAt: START,
      endsAt: null,
      location: null,
      notes: null,
    },
    lead.id,
  );

  const outcome = await recordEventCheckIn(
    event.id,
    { kind: "walkUp", name: "Sam Rivera", email: "sam@yale.edu" },
    door.id,
  );
  expect(outcome.alreadyCheckedIn).toBe(false);
});

// ---------------------------------------------------------------------------
// What the door reads back
// ---------------------------------------------------------------------------

it("re-measures blockers on a second scan instead of going blank", async () => {
  const { cycle, lead, door } = await seed();
  const { acceptance } = await seedAccepted(cycle.id, lead.id, {
    first: "Ada",
    last: "Lovelace",
    email: "ada@yale.edu",
  });
  const event = await trainingEvent(cycle.id, lead.id);
  const target = { kind: "applicant" as const, acceptanceId: acceptance.id };

  const first = await recordEventCheckIn(event.id, target, door.id);
  const second = await recordEventCheckIn(event.id, target, door.id);

  expect(second.alreadyCheckedIn).toBe(true);
  // The operator scanning somebody twice is asking "what did you say I need?".
  expect(second.blockerKeys).toEqual(first.blockerKeys);
  expect(second.blockers).toEqual(first.blockers);
  // ...but no second email, and only one row.
  expect(second.nudgeQueued).toBe(false);
  expect(await prisma.eventAttendance.count({ where: { eventId: event.id } })).toBe(1);
});

it("does not list the training the attendee is standing in the room for", async () => {
  // Clearance is measured before the transaction credits this session, so
  // without the subtraction the door tells an operator that the person in front
  // of them still needs the training they are currently attending -- and mails
  // them the same thing.
  const { term, deptA, cycle, lead } = await seed();
  // Clearance only raises the training task for the term's DESIGNATED training
  // cycle (see clearance.ts's designatedTracks), so without this the blocker
  // under test is never raised and the assertion below passes vacuously.
  await prisma.recruitmentCycle.update({
    where: { id: cycle.id },
    data: { isTermTraining: true },
  });
  const member = await seedMember(term.id, deptA.id, "Vol", "vol@yale.edu");
  const event = await trainingEvent(cycle.id, lead.id);

  // It really is outstanding right up until this check-in credits it.
  expect(
    (await resolveBlockersFor(member.id, term.id)).keys,
  ).toContain("training");

  const outcome = await recordEventCheckIn(
    event.id,
    { kind: "person", personId: member.id },
    lead.id,
  );
  expect(outcome.trainingCredited).toBe(true);
  expect(outcome.blockerKeys).not.toContain("training");
  expect(outcome.blockers.join(" ")).not.toContain("volunteer training");
  // The rest of their clearance is untouched.
  expect(outcome.blockerKeys).toContain("hipaa");

  // And it is not persisted as outstanding either, which is what would otherwise
  // put somebody with nothing else missing into the nudge stream.
  const row = await prisma.eventAttendance.findUniqueOrThrow({ where: { id: outcome.attendanceId } });
  expect(row.blockersAtCheckIn).not.toContain("training");
});

it("still lists training at an event that does not credit it", async () => {
  const { term, deptA, cycle, lead, door } = await seed();
  await prisma.recruitmentCycle.update({
    where: { id: cycle.id },
    data: { isTermTraining: true },
  });
  const member = await seedMember(term.id, deptA.id, "Vol", "vol@yale.edu");
  const event = await createEvent(
    {
      termId: term.id,
      cycleId: null,
      kind: "INFO_SESSION",
      title: "Open house",
      startsAt: START,
      endsAt: null,
      location: null,
      notes: null,
    },
    lead.id,
  );

  const outcome = await recordEventCheckIn(
    event.id,
    { kind: "person", personId: member.id },
    door.id,
  );
  expect(outcome.trainingCredited).toBe(false);
  // An info session credits nothing, so their outstanding training is still
  // outstanding and saying so is correct.
  expect(outcome.blockerKeys).toContain("training");
});

it("counts the accepted roll by person, not by acceptance row", async () => {
  const { cycle, lead } = await seed();
  const { application } = await seedAccepted(cycle.id, lead.id, {
    first: "Ada",
    last: "Lovelace",
    email: "ada@yale.edu",
    deptCode: "SRHD",
  });
  // Accepted by a second department: two rows, still one person through the door.
  await prisma.acceptance.create({
    data: { applicationId: application.id, departmentCode: "INTP", approvedById: lead.id },
  });
  await seedAccepted(cycle.id, lead.id, { first: "Grace", last: "Hopper", email: "grace@yale.edu" });

  expect(await countAcceptedForCycle(cycle.id)).toBe(2);
  expect(await countAcceptedForCycle(null)).toBeNull();
});

// ---------------------------------------------------------------------------
// Two piles: who the session is for, and who else turned up
// ---------------------------------------------------------------------------

it("marks a director at a volunteer training as not expected, but still listed", async () => {
  const { term, deptA, cycle, lead, door } = await seed();
  await seedMember(term.id, deptA.id, "Vol");
  await seedDirector(term.id, deptA.id);
  await seedAccepted(cycle.id, lead.id, { first: "Ada", last: "Lovelace", email: "ada@yale.edu" });
  const event = await trainingEvent(cycle.id, lead.id);

  const rows = await listCheckInCandidates(event.id, door.id);
  const by = (name: string) => rows.find((c) => c.name === name);

  // The people the session is for: this cycle's track, and its acceptances.
  expect(by("Vol")?.expected).toBe(true);
  expect(by("Ada Lovelace")?.expected).toBe(true);
  // A director is on the term roster and in the room, and is not one of them.
  expect(by("Dir")?.expected).toBe(false);
  // Listed either way: they turn up, and recording that is the point.
  expect(by("Dir")).toBeDefined();
});

it("counts a dual-role person as expected at their volunteer track's training", async () => {
  const { term, deptA, deptB, cycle, lead, door } = await seed();
  const person = await seedMember(term.id, deptA.id, "Both Hats");
  await prisma.termMembership.create({
    data: { personId: person.id, termId: term.id, departmentId: deptB.id, kind: "DIRECTOR", status: "ACTIVE" },
  });
  const event = await trainingEvent(cycle.id, lead.id);

  const row = (await listCheckInCandidates(event.id, door.id)).find((c) => c.id === person.id);
  // Holding a DIRECTOR membership too does not take them out of the cohort: they
  // owe the volunteer training their VOLUNTEER membership requires.
  expect(row?.expected).toBe(true);
});

it("expects everybody at an event with no cycle, where there is no cohort", async () => {
  const { term, deptA, lead, door } = await seed();
  await seedMember(term.id, deptA.id, "Vol");
  await seedDirector(term.id, deptA.id);
  const event = await createEvent(
    {
      termId: term.id,
      cycleId: null,
      kind: "INFO_SESSION",
      title: "Open house",
      startsAt: START,
      endsAt: null,
      location: null,
      notes: null,
    },
    lead.id,
  );

  const rows = await listCheckInCandidates(event.id, door.id);
  expect(rows.every((c) => c.expected)).toBe(true);
});

// ---------------------------------------------------------------------------
// The change stream's two reads
// ---------------------------------------------------------------------------

it("moves the revision on a check-in and on an undo", async () => {
  const { term, deptA, cycle, lead } = await seed();
  const member = await seedMember(term.id, deptA.id, "Vol");
  const event = await trainingEvent(cycle.id, lead.id);

  const empty = await attendanceRevision(event.id);
  const { attendanceId } = await recordEventCheckIn(
    event.id,
    { kind: "person", personId: member.id },
    lead.id,
  );
  const afterCheckIn = await attendanceRevision(event.id);
  expect(afterCheckIn).not.toBe(empty);

  // Count alone would return to its starting value here, which is exactly why
  // the stamp carries the latest updatedAt as well.
  await removeEventCheckIn(attendanceId, lead.id);
  const afterUndo = await attendanceRevision(event.id);
  expect(afterUndo).not.toBe(afterCheckIn);
});

it("holds the revision still when nothing changes, so an idle door sends nothing", async () => {
  const { term, deptA, cycle, lead } = await seed();
  const member = await seedMember(term.id, deptA.id, "Vol");
  const event = await trainingEvent(cycle.id, lead.id);
  await recordEventCheckIn(event.id, { kind: "person", personId: member.id }, lead.id);

  expect(await attendanceRevision(event.id)).toBe(await attendanceRevision(event.id));
});

it("snapshots both identity currencies, so either candidate shape can be matched", async () => {
  const { term, deptA, cycle, lead, door } = await seed();
  const member = await seedMember(term.id, deptA.id, "Vol", "vol@yale.edu");
  const { acceptance } = await seedAccepted(cycle.id, lead.id, {
    first: "Ada",
    last: "Lovelace",
    email: "Ada@yale.edu",
  });
  const event = await trainingEvent(cycle.id, lead.id);
  await recordEventCheckIn(event.id, { kind: "person", personId: member.id }, door.id);
  await recordEventCheckIn(event.id, { kind: "applicant", acceptanceId: acceptance.id }, door.id);

  const snapshot = await doorSnapshot(event.id);
  expect(snapshot.revision).toBe(await attendanceRevision(event.id));
  // A member is matched by id; an unlinked applicant row only by its lowercased
  // email, which is the only handle that row has.
  expect(snapshot.personIds).toEqual([member.id]);
  expect(snapshot.emails).toEqual(["ada@yale.edu"]);
  // Names in check-in order, resolved through the Person where there is one.
  expect(snapshot.names).toEqual(["Vol", "Ada Lovelace"]);
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
    { kind: "walkUp", name: "Suggest Me", email: "suggest@yale.edu", confirmed: true },
    lead.id,
  );
  const person = await prisma.person.create({
    data: { name: "Suggest Me", status: "ACTIVE", contactEmail: "Suggest@Yale.edu" },
  });

  const detail = await getEventDetail(event.id);
  expect(detail?.linkSuggestions).toHaveLength(1);
  expect(detail?.linkSuggestions[0]!.personId).toBe(person.id);
});
