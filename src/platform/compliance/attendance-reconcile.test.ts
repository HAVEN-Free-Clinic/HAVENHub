/**
 * Tests for the unlinked-attendance reconcile.
 *
 * The case it exists for: a waitlisted applicant recorded by hand at a door,
 * before the door could list the waitlist, carrying the stranger's `contract`
 * blocker and chased to the attempt cap for an onboarding form that is minted
 * from an acceptance they do not have. Past the cap the nudge stream never looks
 * at that row again, so it stays wrong until something walks it.
 */

import { afterEach, beforeEach, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { reconcileAttendanceStanding } from "./attendance-reconcile";

const NOW = new Date("2026-09-03T12:00:00.000Z");
const CHECKED_IN = new Date("2026-08-20T22:00:00.000Z");

async function seedCycleEvent() {
  const term = await prisma.term.create({
    data: {
      code: "FA26",
      name: "Fall 2026",
      startDate: new Date("2026-08-01T12:00:00.000Z"),
      endDate: new Date("2026-12-15T12:00:00.000Z"),
      status: "ACTIVE",
    },
  });
  const lead = await prisma.person.create({ data: { name: "Lead", status: "ACTIVE" } });
  const cycle = await prisma.recruitmentCycle.create({
    data: {
      track: "VOLUNTEER",
      termId: term.id,
      title: "Fall 2026 Volunteers",
      publicSlug: "fa26-vol",
      departments: ["SRHD"],
      createdById: lead.id,
      status: "OPEN",
    },
  });
  const event = await prisma.attendanceEvent.create({
    data: {
      termId: term.id,
      cycleId: cycle.id,
      kind: "INFO_SESSION",
      title: "Fall info session",
      startsAt: CHECKED_IN,
    },
  });
  return { term, lead, cycle, event };
}

/** An applicant on the cycle's waitlist, with no Acceptance and no Person. */
async function seedWaitlistedApplicant(cycleId: string, email: string) {
  const applicant = await prisma.applicant.create({
    data: {
      cycleId,
      firstName: "Wanda",
      lastName: "Volunteer",
      email,
      emailLower: email.toLowerCase(),
    },
  });
  return prisma.application.create({
    data: {
      cycleId,
      applicantId: applicant.id,
      answers: {},
      applicantType: "NEW",
      departmentChoices: ["SRHD"],
      routedDepartmentCode: "SRHD",
      decision: "WAITLIST",
    },
  });
}

/** The row a hand-typed check-in leaves behind: no Person, keyed on an address. */
async function seedHandTyped(
  eventId: string,
  opts: {
    email?: string;
    blockers?: string[];
    resolvedAt?: Date | null;
    nudgeCount?: number;
  } = {},
) {
  return prisma.eventAttendance.create({
    data: {
      eventId,
      attendeeName: "Wanda V",
      attendeeEmail: opts.email ?? "wanda@yale.edu",
      method: "WALK_UP",
      checkedInAt: CHECKED_IN,
      blockersAtCheckIn: opts.blockers ?? ["contract"],
      resolvedAt: opts.resolvedAt ?? null,
      // Chased to the cap, which is exactly what puts this row beyond the nudge
      // stream's reach and leaves the reconcile as the only thing that can fix it.
      nudgeCount: opts.nudgeCount ?? 3,
    },
  });
}

beforeEach(async () => {
  await resetDb();
});
afterEach(async () => {
  await resetDb();
});

it("settles a hand-typed waitlisted row the nudge stream can no longer reach", async () => {
  const { cycle, event } = await seedCycleEvent();
  await seedWaitlistedApplicant(cycle.id, "wanda@yale.edu");
  const row = await seedHandTyped(event.id);

  const { counts, rows } = await reconcileAttendanceStanding({ dryRun: false, now: NOW });

  expect(counts.resolved).toBe(1);
  expect(rows[0].before).toEqual(["contract"]);
  expect(rows[0].after).toEqual([]);

  const after = await prisma.eventAttendance.findUniqueOrThrow({ where: { id: row.id } });
  expect(after.blockersAtCheckIn).toEqual([]);
  expect(after.resolvedAt).toEqual(NOW);
});

it("writes nothing on a dry run, however much it would change", async () => {
  const { cycle, event } = await seedCycleEvent();
  await seedWaitlistedApplicant(cycle.id, "wanda@yale.edu");
  const row = await seedHandTyped(event.id);

  const { counts } = await reconcileAttendanceStanding({ dryRun: true, now: NOW });

  // Reported in full, so the dry run is a preview rather than a different answer.
  expect(counts.resolved).toBe(1);
  const after = await prisma.eventAttendance.findUniqueOrThrow({ where: { id: row.id } });
  expect(after.blockersAtCheckIn).toEqual(["contract"]);
  expect(after.resolvedAt).toBeNull();
});

it("puts a promoted applicant's row back into the stream", async () => {
  const { lead, cycle, event } = await seedCycleEvent();
  const application = await seedWaitlistedApplicant(cycle.id, "wanda@yale.edu");
  // Settled while they were waitlisted...
  const row = await seedHandTyped(event.id, { blockers: [], resolvedAt: NOW });
  // ...then a spot opened, and now they owe the contract after all.
  await prisma.acceptance.create({
    data: { applicationId: application.id, departmentCode: "SRHD", approvedById: lead.id },
  });

  const { counts } = await reconcileAttendanceStanding({ dryRun: false, now: NOW });

  expect(counts.reopened).toBe(1);
  const after = await prisma.eventAttendance.findUniqueOrThrow({ where: { id: row.id } });
  expect(after.blockersAtCheckIn).toEqual(["contract"]);
  expect(after.resolvedAt).toBeNull();
  // The cap is untouched, so re-opening never becomes a fresh round of email for
  // somebody already chased three times.
  expect(after.nudgeCount).toBe(3);
});

it("leaves a genuine stranger owing an application", async () => {
  const { event } = await seedCycleEvent();
  const row = await seedHandTyped(event.id, { email: "nobody@yale.edu" });

  const { counts } = await reconcileAttendanceStanding({ dryRun: false, now: NOW });

  expect(counts.unchanged).toBe(1);
  const after = await prisma.eventAttendance.findUniqueOrThrow({ where: { id: row.id } });
  expect(after.blockersAtCheckIn).toEqual(["contract"]);
  expect(after.resolvedAt).toBeNull();
});

it("never touches a row that has a Person, whose blockers are live anyway", async () => {
  const { event } = await seedCycleEvent();
  const person = await prisma.person.create({ data: { name: "Member", status: "ACTIVE" } });
  await prisma.eventAttendance.create({
    data: {
      eventId: event.id,
      personId: person.id,
      method: "STAFF",
      checkedInAt: CHECKED_IN,
      blockersAtCheckIn: ["contract"],
    },
  });

  const { rows } = await reconcileAttendanceStanding({ dryRun: false, now: NOW });

  expect(rows).toEqual([]);
});

it("is safe to re-run: the second pass changes nothing", async () => {
  const { cycle, event } = await seedCycleEvent();
  await seedWaitlistedApplicant(cycle.id, "wanda@yale.edu");
  await seedHandTyped(event.id);

  const first = await reconcileAttendanceStanding({ dryRun: false, now: NOW });
  expect(first.counts.resolved).toBe(1);

  const second = await reconcileAttendanceStanding({
    dryRun: false,
    now: new Date(NOW.getTime() + 86_400_000),
  });
  expect(second.counts).toEqual({ resolved: 0, reopened: 0, rewritten: 0, unchanged: 1 });

  // And the settled-at stamp is the first pass's, not the second's: re-running
  // must not keep moving the moment the clinic established there was nothing left.
  const after = await prisma.eventAttendance.findFirstOrThrow({
    where: { eventId: event.id },
  });
  expect(after.resolvedAt).toEqual(NOW);
});
