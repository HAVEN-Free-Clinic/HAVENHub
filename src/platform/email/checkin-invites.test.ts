import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
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
  beforeEach(resetDb);

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
