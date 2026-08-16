import { describe, it, expect, beforeEach, vi } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";

// Shared mutable flag read by the renderEmail mock below. vi.mock factories are
// hoisted above other statements, so the flag must itself be created via
// vi.hoisted to be visible inside the factory closure. Used by exactly one
// test (the claim-release test) to force renderEmail to throw for a named
// person on demand, without depending on Map iteration order.
const { renderState } = vi.hoisted(() => ({ renderState: { failFirstName: null as string | null } }));

vi.mock("./templates/renderEmail", () => ({
  renderEmail: vi.fn(async (_key: string, context: Record<string, unknown>) => {
    if (renderState.failFirstName && (context as { firstName?: string }).firstName === renderState.failFirstName) {
      throw new Error("simulated render failure");
    }
    return { subject: "Check in for clinic today", html: "<p>Check in</p>" };
  }),
}));

import { runCheckInInvites } from "./checkin-invites";

const CLINIC_DATE = new Date("2026-03-07T12:00:00Z");
const SATURDAY_MORNING = new Date("2026-03-07T11:00:00Z");
const WEDNESDAY = new Date("2026-03-04T11:00:00Z");

async function seed() {
  const term = await prisma.term.create({
    data: {
      code: "TS26",
      name: "Test 2026",
      startDate: new Date("2026-01-01T00:00:00Z"),
      endDate: new Date("2026-06-01T00:00:00Z"),
      status: "ACTIVE",
      clinicDates: [CLINIC_DATE],
    },
  });
  const dept = await prisma.department.create({ data: { code: "SCTP", name: "Screening" } });
  const scheduled = await prisma.person.create({
    data: { name: "Ada Lovelace", contactEmail: "ada@example.com" },
  });
  const unscheduled = await prisma.person.create({
    data: { name: "Katherine Johnson", contactEmail: "kj@example.com" },
  });
  await prisma.termMembership.createMany({
    data: [
      { termId: term.id, departmentId: dept.id, personId: scheduled.id, kind: "VOLUNTEER", status: "ACTIVE" },
      { termId: term.id, departmentId: dept.id, personId: unscheduled.id, kind: "VOLUNTEER", status: "ACTIVE" },
    ],
  });
  await prisma.shiftAssignment.create({
    data: {
      termId: term.id,
      departmentId: dept.id,
      personId: scheduled.id,
      clinicDate: CLINIC_DATE,
      role: "VOLUNTEER",
    },
  });
  return { term, scheduled, unscheduled };
}

describe("runCheckInInvites", () => {
  beforeEach(async () => {
    await resetDb();
    renderState.failFirstName = null;
  });

  it("no-ops when today is not a clinic date", async () => {
    await seed();
    const result = await runCheckInInvites(WEDNESDAY);
    expect(result).toEqual({ skipped: true, queued: 0 });
    expect(await prisma.emailLog.count()).toBe(0);
  });

  it("queues exactly the people assigned that clinic date", async () => {
    const { scheduled, unscheduled } = await seed();
    const result = await runCheckInInvites(SATURDAY_MORNING);

    expect(result.skipped).toBe(false);
    expect(result.queued).toBe(1);

    const logs = await prisma.emailLog.findMany({ select: { personId: true } });
    expect(logs.map((l) => l.personId)).toEqual([scheduled.id]);
    expect(logs.map((l) => l.personId)).not.toContain(unscheduled.id);
  });

  it("is idempotent: running twice on the same clinic day queues each person once", async () => {
    const { scheduled } = await seed();

    const first = await runCheckInInvites(SATURDAY_MORNING);
    expect(first.queued).toBe(1);

    // Simulates an external-scheduler retry (timeout / 5xx) re-firing the same
    // cron for the same clinic morning. Must not send a second invite.
    const second = await runCheckInInvites(SATURDAY_MORNING);
    expect(second.skipped).toBe(false);
    expect(second.queued).toBe(0);

    const logs = await prisma.emailLog.findMany({ where: { personId: scheduled.id } });
    expect(logs.length).toBe(1);
  });

  it("releases the claim on a failed enqueue so a later run retries that same person", async () => {
    const term = await prisma.term.create({
      data: {
        code: "TS26",
        name: "Test 2026",
        startDate: new Date("2026-01-01T00:00:00Z"),
        endDate: new Date("2026-06-01T00:00:00Z"),
        status: "ACTIVE",
        clinicDates: [CLINIC_DATE],
      },
    });
    const dept = await prisma.department.create({ data: { code: "SCTP", name: "Screening" } });
    const failing = await prisma.person.create({ data: { name: "Fail Person", contactEmail: "fail@example.com" } });
    const succeeding = await prisma.person.create({
      data: { name: "Succeed Person", contactEmail: "succeed@example.com" },
    });
    await prisma.termMembership.createMany({
      data: [
        { termId: term.id, departmentId: dept.id, personId: failing.id, kind: "VOLUNTEER", status: "ACTIVE" },
        { termId: term.id, departmentId: dept.id, personId: succeeding.id, kind: "VOLUNTEER", status: "ACTIVE" },
      ],
    });
    await prisma.shiftAssignment.createMany({
      data: [
        { termId: term.id, departmentId: dept.id, personId: failing.id, clinicDate: CLINIC_DATE, role: "VOLUNTEER" },
        { termId: term.id, departmentId: dept.id, personId: succeeding.id, clinicDate: CLINIC_DATE, role: "VOLUNTEER" },
      ],
    });

    // First run: renderEmail throws for "Fail Person" only; "Succeed Person" goes
    // through normally. The bad recipient must not abort the batch, and the claim
    // taken for the failing person before the throw must be released, not stranded.
    renderState.failFirstName = "Fail";
    const first = await runCheckInInvites(SATURDAY_MORNING);
    expect(first.skipped).toBe(false);
    expect(first.queued).toBe(1);
    expect(await prisma.emailLog.findFirst({ where: { personId: succeeding.id } })).not.toBeNull();
    expect(await prisma.emailLog.findFirst({ where: { personId: failing.id } })).toBeNull();

    // Second run, same clinic day, rendering now succeeds for everyone. If the
    // claim taken for "Fail Person" on the first run had NOT been released, this
    // run would skip them again (queued: 0, still no EmailLog row) exactly like a
    // person permanently and silently locked out of their check-in invite.
    renderState.failFirstName = null;
    const second = await runCheckInInvites(SATURDAY_MORNING);
    expect(second.queued).toBe(1);
    expect(await prisma.emailLog.findFirst({ where: { personId: failing.id } })).not.toBeNull();
    // "Succeed Person" was already claimed and queued on the first run, so the
    // retry must not queue them a second time.
    expect(await prisma.emailLog.count({ where: { personId: succeeding.id } })).toBe(1);
  });

  it("queues one email for a person assigned to two departments", async () => {
    const { term, scheduled } = await seed();
    const second = await prisma.department.create({ data: { code: "JCTP", name: "Joint Clinic" } });
    await prisma.termMembership.create({
      data: { termId: term.id, departmentId: second.id, personId: scheduled.id, kind: "VOLUNTEER", status: "ACTIVE" },
    });
    await prisma.shiftAssignment.create({
      data: {
        termId: term.id,
        departmentId: second.id,
        personId: scheduled.id,
        clinicDate: CLINIC_DATE,
        role: "VOLUNTEER",
      },
    });

    const result = await runCheckInInvites(SATURDAY_MORNING);
    expect(result.queued).toBe(1);
    expect(await prisma.emailLog.count()).toBe(1);
  });

  it("no-ops when there is no active term", async () => {
    const { term } = await seed();
    await prisma.term.update({ where: { id: term.id }, data: { status: "ARCHIVED" } });
    expect(await runCheckInInvites(SATURDAY_MORNING)).toEqual({ skipped: true, queued: 0 });
  });

  // audit 14, CLINIC-01. A closed Saturday stays in Term.clinicDates by design
  // (the schema says so, and createTerm seeds every Saturday), and closure is a
  // flag on ClinicDay. Only the ATTENDING-facing readers honoured it, so on a
  // cancelled clinic the doctors were stood down and every assigned volunteer
  // was still emailed "You are scheduled for clinic today".
  it("skips a clinic date that has been closed", async () => {
    const { term } = await seed();
    const clinicDate = term.clinicDates[0];
    await prisma.clinicDay.create({
      data: { termId: term.id, clinicDate, isClosed: true },
    });

    expect(await runCheckInInvites(SATURDAY_MORNING)).toEqual({ skipped: true, queued: 0 });
    expect(await prisma.emailLog.count()).toBe(0);
  });

  it("still runs when a ClinicDay row exists but the day is open", async () => {
    const { term } = await seed();
    await prisma.clinicDay.create({
      data: { termId: term.id, clinicDate: term.clinicDates[0], isClosed: false },
    });

    const result = await runCheckInInvites(SATURDAY_MORNING);
    expect(result.skipped).toBe(false);
    expect(result.queued).toBeGreaterThan(0);
  });

  it("does not send: it only enqueues", async () => {
    await seed();
    await runCheckInInvites(SATURDAY_MORNING);
    const logs = await prisma.emailLog.findMany({ select: { status: true } });
    // EmailStatus has no "PENDING" member (QUEUED | SENT | FAILED); notify()'s
    // queueEmail leaves a freshly-enqueued row at QUEUED. See task-8-report.md
    // for the brief discrepancy this corrects.
    expect(logs.every((l) => l.status === "QUEUED")).toBe(true);
  });
});
