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

/**
 * Point a schedule column at the department that covers SCTP, the department
 * every recipient below belongs to.
 *
 * Columns name the clinical PARENT (PCAR), and SCTP reaches them through the
 * one-hop delegation the clinic already models -- which is exactly the path the
 * reminder has to walk to name the right attending, so the fixture builds it
 * rather than shortcutting to a direct mapping.
 */
async function columnCoveringSctp(): Promise<string> {
  const pcar = await createDepartment("PCAR", "Primary Care Advisors");
  const sctp = await createDepartment("SCTP", "Senior Primary Care");
  const existing = await prisma.departmentDelegation.findFirst({
    where: { managerDepartmentId: pcar.id, managedDepartmentId: sctp.id },
  });
  if (!existing) {
    await prisma.departmentDelegation.create({
      data: { managerDepartmentId: pcar.id, managedDepartmentId: sctp.id },
    });
  }
  return pcar.id;
}

/**
 * The clinic-wide day for `clinicDate`, staffed by `attendingId` in one column.
 *
 * There is ONE schedule for the Saturday, so repeated calls add to the same day
 * rather than creating a second one.
 */
async function scheduleAttending(
  termId: string,
  clinicDate: Date,
  attendingId: string,
  slotLabel = "9am-12pm",
) {
  const departmentId = await columnCoveringSctp();
  const slot = await prisma.clinicSlot.upsert({
    where: { label: slotLabel },
    update: { departmentId },
    create: {
      label: slotLabel,
      startTime: "09:00",
      endTime: "12:00",
      order: 0,
      allowsMultiple: true,
      departmentId,
    },
  });
  const day = await prisma.clinicDay.upsert({
    where: { termId_clinicDate: { termId, clinicDate } },
    update: {},
    create: { termId, clinicDate },
  });
  await prisma.clinicDayAttending.create({
    data: { clinicDayId: day.id, slotId: slot.id, attendingId },
  });
  return day;
}

describe("runShiftReminders", () => {
  it("sends one reminder per scheduled person and embeds on-shift leadership", async () => {
    const target = futureClinicDate(5);
    const term = await createTerm([target]);
    const sctp = await createDepartment("SCTP", "Senior Primary Care");
    const exec = await createDepartment("EXEC", "Executive Directors");
    // PCAR is a real department whose directors are the Clinical Advisors named
    // in the email. Unrelated to attendings, who belong to no department.
    const pcar = await createDepartment("PCAR", "Primary Care Advisors");

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
      where: { personId: gone.id, termId: term.id },
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

  // A department can be covered by more than one column -- primary care is
  // staffed by two overlapping windows -- and the reminder names each with the
  // window it covers, the same shape as the schedule itself.
  it("names every column covering the recipient's department", async () => {
    const target = futureClinicDate(3);
    const term = await createTerm([target]);
    const sctp = await createDepartment("SCTP", "Senior Primary Care");
    const vol = await createPerson("Val Volunteer", "val@x.org");
    await schedule(term.id, sctp.id, vol.id, target, "VOLUNTEER");

    const ellis = await prisma.attending.create({
      data: { scheduleName: "Ellis", fullName: "Dr. Ellis" },
    });
    const finch = await prisma.attending.create({
      data: { scheduleName: "Finch", fullName: "Dr. Finch" },
    });
    await scheduleAttending(term.id, target, ellis.id);
    await scheduleAttending(term.id, target, finch.id, "RHD Attending");

    await runShiftReminders(NOW);

    const log = await prisma.emailLog.findFirstOrThrow({ where: { template: "shift-reminder" } });
    expect(log.html).toContain("Ellis (9am-12pm)");
    expect(log.html).toContain("Finch (RHD Attending)");
  });

  // The defect the per-department scoping exists to fix: one clinic-wide string
  // told a behavioral health volunteer the primary care attending's name.
  it("does not name a column that covers a different department", async () => {
    const target = futureClinicDate(3);
    const term = await createTerm([target]);
    const sctp = await createDepartment("SCTP", "Senior Primary Care");
    const vol = await createPerson("Val Volunteer", "val@x.org");
    await schedule(term.id, sctp.id, vol.id, target, "VOLUNTEER");

    const ours = await prisma.attending.create({
      data: { scheduleName: "Ellis", fullName: "Dr. Ellis" },
    });
    const theirs = await prisma.attending.create({
      data: { scheduleName: "Okafor", fullName: "Dr. Okafor" },
    });
    await scheduleAttending(term.id, target, ours.id);

    // Behavioral health is on the same clinic day, on its own column, covering
    // a department this recipient has nothing to do with.
    const bvhd = await createDepartment("BVHD", "Behavioral Health");
    const bhdSlot = await prisma.clinicSlot.create({
      data: {
        label: "BHD Clinic",
        startTime: "09:00",
        endTime: "13:00",
        order: 3,
        departmentId: bvhd.id,
      },
    });
    const day = await prisma.clinicDay.findFirstOrThrow({ where: { termId: term.id } });
    await prisma.clinicDayAttending.create({
      data: { clinicDayId: day.id, slotId: bhdSlot.id, attendingId: theirs.id },
    });

    await runShiftReminders(NOW);

    const log = await prisma.emailLog.findFirstOrThrow({ where: { template: "shift-reminder" } });
    expect(log.html).toContain("Ellis (9am-12pm)");
    expect(log.html).not.toContain("Okafor");
  });

  // Two attendings can cover the same clinic day in different windows, so the
  // reminder must name both and say which window each covers.
  it("names both attendings when the day is split across columns", async () => {
    const target = futureClinicDate(3);
    const term = await createTerm([target]);
    const sctp = await createDepartment("SCTP", "Senior Primary Care");
    const vol = await createPerson("Val Volunteer", "val@x.org");
    await schedule(term.id, sctp.id, vol.id, target, "VOLUNTEER");

    const am = await prisma.attending.create({
      data: { scheduleName: "Ellis", fullName: "Dr. Ellis" },
    });
    const pm = await prisma.attending.create({
      data: { scheduleName: "Chen", fullName: "Dr. Chen" },
    });

    const departmentId = await columnCoveringSctp();
    const morning = await prisma.clinicSlot.create({
      data: {
        label: "9am-12pm",
        startTime: "09:00",
        endTime: "12:00",
        order: 0,
        allowsMultiple: true,
        departmentId,
      },
    });
    const midday = await prisma.clinicSlot.create({
      data: { label: "11am-2pm", startTime: "11:00", endTime: "14:00", order: 1, departmentId },
    });
    await prisma.clinicDay.create({
      data: {
        termId: term.id,
        clinicDate: target,
        attendings: {
          create: [
            { slotId: morning.id, attendingId: am.id },
            { slotId: midday.id, attendingId: pm.id },
          ],
        },
      },
    });

    await runShiftReminders(NOW);

    const log = await prisma.emailLog.findFirstOrThrow({ where: { template: "shift-reminder" } });
    expect(log.html).toContain("Ellis (9am-12pm)");
    expect(log.html).toContain("Chen (11am-2pm)");
  });

  // A deactivated attending must not be announced as covering the shift, but the
  // row is kept so a manager can see the gap and fill it.
  it("omits a deactivated attending", async () => {
    const target = futureClinicDate(3);
    const term = await createTerm([target]);
    const sctp = await createDepartment("SCTP", "Senior Primary Care");
    const vol = await createPerson("Val Volunteer", "val@x.org");
    await schedule(term.id, sctp.id, vol.id, target, "VOLUNTEER");

    const retired = await prisma.attending.create({
      data: { scheduleName: "Retired", fullName: "Dr. Retired", isActive: false },
    });
    await scheduleAttending(term.id, target, retired.id);

    await runShiftReminders(NOW);

    const log = await prisma.emailLog.findFirstOrThrow({ where: { template: "shift-reminder" } });
    expect(log.html).not.toContain("Dr. Retired");
    expect(log.html).not.toContain("Attending on shift");
  });
});
