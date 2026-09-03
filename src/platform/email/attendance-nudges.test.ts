/**
 * Integration tests for the recurring check-in nudge stream.
 *
 * "now" is pinned in every test so the interval claim and the lookback window
 * are deterministic, matching how reminders.test.ts drives its engine.
 *
 * The default interval is 7 days (settings registry: attendance.nudgeIntervalDays)
 * and the stream stops after MAX_ATTENDANCE_NUDGES sends.
 */

import { afterEach, beforeEach, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { runAttendanceNudges, MAX_ATTENDANCE_NUDGES } from "./attendance-nudges";

const NOW = new Date("2026-09-03T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

async function seedEvent(startsAt: Date) {
  const term = await prisma.term.create({
    data: {
      code: "FA26",
      name: "Fall 2026",
      startDate: new Date("2026-08-01T12:00:00.000Z"),
      endDate: new Date("2026-12-15T12:00:00.000Z"),
      status: "ACTIVE",
    },
  });
  const event = await prisma.attendanceEvent.create({
    data: { termId: term.id, kind: "INFO_SESSION", title: "Fall info session", startsAt },
  });
  return { term, event };
}

/** A walk-up row: no Person, so email is the only channel and blockers are fixed. */
async function seedWalkUp(
  eventId: string,
  opts: { nudgeCount?: number; nudgeLastSentAt?: Date | null } = {},
) {
  return prisma.eventAttendance.create({
    data: {
      eventId,
      attendeeName: "Walk Up",
      attendeeEmail: "walkup@yale.edu",
      method: "WALK_UP",
      checkedInAt: new Date("2026-08-20T22:00:00.000Z"),
      blockersAtCheckIn: ["contract"],
      nudgeCount: opts.nudgeCount ?? 1,
      nudgeLastSentAt: opts.nudgeLastSentAt ?? null,
    },
  });
}

function nudgeCount() {
  return prisma.emailLog.count({ where: { template: "attendance-nudge" } });
}

beforeEach(async () => {
  await resetDb();
});
afterEach(async () => {
  await resetDb();
});

it("waits out the interval before following up", async () => {
  const { event } = await seedEvent(new Date("2026-08-20T22:00:00.000Z"));
  // Nudged two days ago: inside the 7-day interval.
  await seedWalkUp(event.id, { nudgeLastSentAt: new Date(NOW.getTime() - 2 * DAY) });

  // Nothing sent, and the row is not even a candidate: the interval predicate
  // lives in the WHERE, so a row inside its window never reaches the per-row
  // work at all (which is why it counts as neither sent nor skipped).
  const tooSoon = await runAttendanceNudges(NOW);
  expect(tooSoon).toEqual({ sent: 0, resolved: 0, skipped: 0, failed: 0 });
  expect(await nudgeCount()).toBe(0);

  // Eight days on, the same row is due.
  const due = await runAttendanceNudges(new Date(NOW.getTime() + 8 * DAY));
  expect(due.sent).toBe(1);
  expect(await nudgeCount()).toBe(1);

  const row = await prisma.eventAttendance.findFirstOrThrow({ where: { eventId: event.id } });
  expect(row.nudgeCount).toBe(2);
  const email = await prisma.emailLog.findFirstOrThrow({ where: { template: "attendance-nudge" } });
  expect(email.toEmail).toBe("walkup@yale.edu");
  // No Person, so there is no inbox to write to and no member CTA to offer.
  expect(email.personId).toBeNull();
});

it("stops after the attempt cap", async () => {
  const { event } = await seedEvent(new Date("2026-08-20T22:00:00.000Z"));
  await seedWalkUp(event.id, {
    nudgeCount: MAX_ATTENDANCE_NUDGES,
    nudgeLastSentAt: new Date(NOW.getTime() - 30 * DAY),
  });

  const result = await runAttendanceNudges(NOW);
  expect(result.sent).toBe(0);
  expect(await nudgeCount()).toBe(0);
});

it("ignores events older than the lookback window", async () => {
  // Two terms ago: history, not an open loop.
  const { event } = await seedEvent(new Date("2026-01-10T22:00:00.000Z"));
  await seedWalkUp(event.id, { nudgeLastSentAt: new Date("2026-01-11T22:00:00.000Z") });

  const result = await runAttendanceNudges(NOW);
  expect(result.sent).toBe(0);
  expect(result.skipped).toBe(0);
  expect(await nudgeCount()).toBe(0);
});

it("takes a row out of the stream once nothing is outstanding", async () => {
  const { term, event } = await seedEvent(new Date("2026-08-20T22:00:00.000Z"));
  const dept = await prisma.department.create({ data: { code: "SRHD", name: "SRHD" } });
  const person = await prisma.person.create({
    data: {
      name: "All Done",
      status: "ACTIVE",
      contactEmail: "done@yale.edu",
      phone: "203-555-0000",
    },
  });
  await prisma.termMembership.create({
    data: { personId: person.id, termId: term.id, departmentId: dept.id, kind: "VOLUNTEER", status: "ACTIVE" },
  });
  await prisma.hipaaCertificate.create({
    data: {
      personId: person.id,
      fileName: "c.pdf",
      storedName: "c.pdf",
      size: 1,
      mimeType: "application/pdf",
      completionDate: new Date("2026-08-01T12:00:00.000Z"),
      verifiedAt: new Date("2026-08-02T12:00:00.000Z"),
    },
  });
  // Checked in while their contract was outstanding; everything has since landed.
  const row = await prisma.eventAttendance.create({
    data: {
      eventId: event.id,
      personId: person.id,
      method: "STAFF",
      checkedInAt: new Date("2026-08-20T22:00:00.000Z"),
      blockersAtCheckIn: ["contract", "hipaa"],
      nudgeCount: 1,
      nudgeLastSentAt: new Date(NOW.getTime() - 30 * DAY),
    },
  });

  const result = await runAttendanceNudges(NOW);

  expect(result.resolved).toBe(1);
  expect(result.sent).toBe(0);
  expect(await nudgeCount()).toBe(0);
  const after = await prisma.eventAttendance.findUniqueOrThrow({ where: { id: row.id } });
  expect(after.resolvedAt).not.toBeNull();

  // And it stays out of the stream on the next pass.
  const again = await runAttendanceNudges(new Date(NOW.getTime() + 30 * DAY));
  expect(again.resolved).toBe(0);
  expect(again.skipped).toBe(0);
});

it("skips a linked member with no address rather than claiming the attempt", async () => {
  const { event } = await seedEvent(new Date("2026-08-20T22:00:00.000Z"));
  const person = await prisma.person.create({
    data: { name: "Unreachable", status: "ACTIVE", contactEmail: null },
  });
  const row = await prisma.eventAttendance.create({
    data: {
      eventId: event.id,
      personId: person.id,
      method: "STAFF",
      checkedInAt: new Date("2026-08-20T22:00:00.000Z"),
      blockersAtCheckIn: ["contract"],
      nudgeCount: 1,
      nudgeLastSentAt: new Date(NOW.getTime() - 30 * DAY),
    },
  });

  const result = await runAttendanceNudges(NOW);

  expect(result.sent).toBe(0);
  expect(result.skipped).toBe(1);
  // The attempt is NOT burned: they are retried if an address ever appears.
  const after = await prisma.eventAttendance.findUniqueOrThrow({ where: { id: row.id } });
  expect(after.nudgeCount).toBe(1);
  expect(after.nudgeLastSentAt?.getTime()).toBe(NOW.getTime() - 30 * DAY);
});
