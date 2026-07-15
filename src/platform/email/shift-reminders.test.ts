import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { runShiftReminders } from "./shift-reminders";
import { __resetChannelCache } from "@/platform/teams/channel-link";

// Use the real clock so EmailLog.createdAt lands inside the 6-day dedup window.
const NOW = new Date();

/** A clinic date `daysAhead` in the future, anchored at 12:00 UTC. */
function futureClinicDate(daysAhead: number): Date {
  const d = new Date(NOW);
  d.setUTCHours(12, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + daysAhead);
  return d;
}

beforeEach(async () => {
  await resetDb();
  __resetChannelCache();
});

async function createTerm(clinicDates: Date[]) {
  return prisma.term.create({
    data: {
      code: "SU26",
      name: "Summer 2026",
      startDate: new Date("2026-05-01T00:00:00.000Z"),
      endDate: new Date("2026-08-31T00:00:00.000Z"),
      status: "ACTIVE",
      clinicDates,
    },
  });
}
async function createDepartment(code: string, name: string) {
  return prisma.department.upsert({ where: { code }, update: { name }, create: { code, name } });
}
async function createPerson(name: string, contactEmail: string | null) {
  return prisma.person.create({ data: { name, contactEmail, status: "ACTIVE" } });
}
async function schedule(
  termId: string,
  departmentId: string,
  personId: string,
  clinicDate: Date,
  role: "DIRECTOR" | "VOLUNTEER" | "SHADOW",
) {
  // A scheduled person is an active member of that department; the reminder cron
  // now requires that (so it skips offboarded people with leftover assignments).
  await prisma.termMembership.upsert({
    where: { personId_termId_departmentId_kind: { personId, termId, departmentId, kind: role === "DIRECTOR" ? "DIRECTOR" : "VOLUNTEER" } },
    create: { personId, termId, departmentId, kind: role === "DIRECTOR" ? "DIRECTOR" : "VOLUNTEER", status: "ACTIVE" },
    update: { status: "ACTIVE" },
  });
  return prisma.shiftAssignment.create({ data: { termId, departmentId, personId, clinicDate, role } });
}
async function shiftEmailCount() {
  return prisma.emailLog.count({ where: { template: "shift-reminder" } });
}

describe("runShiftReminders", () => {
  it("sends one reminder per scheduled person and embeds on-shift leadership", async () => {
    const target = futureClinicDate(5);
    const term = await createTerm([target]);
    const sctp = await createDepartment("SCTP", "Senior Primary Care");
    const exec = await createDepartment("EXEC", "Executive Directors");
    const pcar = await createDepartment("PCAR", "Primary Care Clinical Advisors");

    const vol = await createPerson("Val Volunteer", "val@x.org");
    const dir = await createPerson("Dana Director", "dana@x.org");
    const ed = await createPerson("Ed Exec", "ed@x.org");
    const ca = await createPerson("Cara Advisor", "cara@x.org");

    await schedule(term.id, sctp.id, vol.id, target, "VOLUNTEER");
    await schedule(term.id, sctp.id, dir.id, target, "DIRECTOR");
    await schedule(term.id, exec.id, ed.id, target, "DIRECTOR");
    await schedule(term.id, pcar.id, ca.id, target, "DIRECTOR");

    const result = await runShiftReminders(NOW);

    expect(result.remindersSent).toBe(4);
    expect(await shiftEmailCount()).toBe(4);

    const volEmail = await prisma.emailLog.findFirst({ where: { template: "shift-reminder", personId: vol.id } });
    expect(volEmail).not.toBeNull();
    expect(volEmail!.html).toContain("Ed Exec");
    expect(volEmail!.html).toContain("Dana Director");
    expect(volEmail!.html).toContain("Cara Advisor");
  });

  it("does not remind a person whose department membership was removed (offboarded) despite a leftover assignment", async () => {
    const target = futureClinicDate(5);
    const term = await createTerm([target]);
    const sctp = await createDepartment("SCTP", "Senior Primary Care");
    const active = await createPerson("Ava Active", "ava@x.org");
    const gone = await createPerson("Gia Gone", "gia@x.org");
    await schedule(term.id, sctp.id, active.id, target, "VOLUNTEER");
    await schedule(term.id, sctp.id, gone.id, target, "VOLUNTEER");
    // Gia is offboarded: membership flipped to REMOVED, but her future assignment
    // was not cleared. She must not be emailed.
    await prisma.termMembership.updateMany({
      where: { personId: gone.id, termId: term.id, departmentId: sctp.id },
      data: { status: "REMOVED" },
    });

    const result = await runShiftReminders(NOW);
    expect(result.remindersSent).toBe(1);
    expect(await prisma.emailLog.findFirst({ where: { template: "shift-reminder", personId: gone.id } })).toBeNull();
    expect(await prisma.emailLog.findFirst({ where: { template: "shift-reminder", personId: active.id } })).not.toBeNull();
  });

  it("is idempotent within the week (a re-run sends nothing)", async () => {
    const target = futureClinicDate(5);
    const term = await createTerm([target]);
    const sctp = await createDepartment("SCTP", "Senior Primary Care");
    const vol = await createPerson("Val Volunteer", "val@x.org");
    await schedule(term.id, sctp.id, vol.id, target, "VOLUNTEER");

    expect((await runShiftReminders(NOW)).remindersSent).toBe(1);
    const second = await runShiftReminders(NOW);
    expect(second.remindersSent).toBe(0);
    expect(second.skipped).toBe(1);
    expect(await shiftEmailCount()).toBe(1);
  });

  it("skips people with no contact email", async () => {
    const target = futureClinicDate(5);
    const term = await createTerm([target]);
    const sctp = await createDepartment("SCTP", "Senior Primary Care");
    const vol = await createPerson("No Email", null);
    await schedule(term.id, sctp.id, vol.id, target, "VOLUNTEER");

    const result = await runShiftReminders(NOW);
    expect(result.remindersSent).toBe(0);
    expect(result.skipped).toBe(1);
    expect(await shiftEmailCount()).toBe(0);
  });

  it("does nothing when there is no upcoming clinic date", async () => {
    await createTerm([new Date("2020-01-04T12:00:00.000Z")]);
    const result = await runShiftReminders(NOW);
    expect(result.remindersSent).toBe(0);
    expect(await shiftEmailCount()).toBe(0);
  });

  it("does nothing when the next clinic is beyond this week", async () => {
    const target = futureClinicDate(12);
    const term = await createTerm([target]);
    const sctp = await createDepartment("SCTP", "Senior Primary Care");
    const vol = await createPerson("Val Volunteer", "val@x.org");
    await schedule(term.id, sctp.id, vol.id, target, "VOLUNTEER");

    const result = await runShiftReminders(NOW);
    expect(result.remindersSent).toBe(0);
    expect(await shiftEmailCount()).toBe(0);
  });
});
