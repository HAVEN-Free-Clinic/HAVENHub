import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { runAttendingReminders, renderScheduleTable } from "./attending-reminders";
import { FACULTY_RELATIONS_ROLE } from "@/platform/rbac/system-roles";

const NOW = new Date();

/** A clinic date `daysAhead` in the future, anchored at 12:00 UTC. */
function futureClinicDate(daysAhead: number): Date {
  const d = new Date(NOW);
  d.setUTCHours(12, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + daysAhead);
  return d;
}

beforeEach(resetDb);

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

async function slots() {
  const morning = await prisma.clinicSlot.create({
    data: { label: "9am-12pm", startTime: "09:00", endTime: "12:00", order: 0, allowsMultiple: true },
  });
  const midday = await prisma.clinicSlot.create({
    data: { label: "11am-2pm", startTime: "11:00", endTime: "14:00", order: 1 },
  });
  return { morning, midday };
}

async function attending(scheduleName: string, email: string | null, isActive = true) {
  return prisma.attending.create({
    data: { scheduleName, fullName: scheduleName, email, isActive },
  });
}

async function sentCount() {
  return prisma.emailLog.count({ where: { template: "attending-reminder" } });
}

/** A person holding the Faculty Relations role, the way an admin grants it. */
async function facultyRelationsDirector(
  name: string,
  contactEmail: string | null,
  status: "ACTIVE" | "OFFBOARDED" = "ACTIVE",
) {
  const person = await prisma.person.create({ data: { name, contactEmail, status } });
  const role = await prisma.role.upsert({
    where: { name: FACULTY_RELATIONS_ROLE },
    update: {},
    create: { name: FACULTY_RELATIONS_ROLE, isSystem: true },
  });
  await prisma.roleAssignment.create({ data: { roleId: role.id, personId: person.id } });
  return person;
}

/** The Faculty Relations copy of the week's letter, if one was queued. */
async function copyTo(email: string) {
  return prisma.emailLog.findFirst({
    where: { toEmail: email, template: "attending-reminder", subject: { startsWith: "Copy: " } },
  });
}

describe("renderScheduleTable", () => {
  it("writes one bold slot label per line, matching the letter sent by hand", () => {
    const html = renderScheduleTable([
      {
        slotLabel: "9am-12pm",
        attendings: [
          { id: "a", scheduleName: "Dr. Frank Bia", email: null },
          { id: "b", scheduleName: "Dr. Peggy Bia", email: null },
        ],
      },
      { slotLabel: "11am-2pm", attendings: [{ id: "c", scheduleName: "Dr. Jack Peng", email: null }] },
    ]);

    expect(html).toBe(
      "<p><strong>9am-12pm</strong>: Dr. Frank Bia, Dr. Peggy Bia<br/>" +
        "<strong>11am-2pm</strong>: Dr. Jack Peng</p>",
    );
  });

  it("omits a slot nobody covers rather than printing an empty line", () => {
    const html = renderScheduleTable([
      { slotLabel: "9am-12pm", attendings: [{ id: "a", scheduleName: "Rivera", email: null }] },
      { slotLabel: "BHD Clinic", attendings: [] },
    ]);
    expect(html).not.toContain("BHD Clinic");
  });

  // The template renders this block raw, so escaping has to happen here.
  it("escapes names, since the template renders this raw", () => {
    const html = renderScheduleTable([
      { slotLabel: "9am-12pm", attendings: [{ id: "a", scheduleName: "A <b>& Co</b>", email: null }] },
    ]);
    expect(html).toContain("&lt;b&gt;");
    expect(html).not.toContain("<b>&");
  });
});

describe("runAttendingReminders", () => {
  it("emails each attending covering the upcoming clinic day, once", async () => {
    const target = futureClinicDate(5);
    const term = await createTerm([target]);
    const { morning, midday } = await slots();
    const peggy = await attending("Peggy Bia", "peggy@yale.edu");
    const frank = await attending("Frank Bia", "frank@yale.edu");
    const peng = await attending("Jack Peng", "peng@yale.edu");

    await prisma.clinicDay.create({
      data: {
        termId: term.id,
        clinicDate: target,
        attendings: {
          create: [
            { slotId: morning.id, attendingId: peggy.id, order: 0 },
            { slotId: morning.id, attendingId: frank.id, order: 1 },
            { slotId: midday.id, attendingId: peng.id },
          ],
        },
      },
    });

    const result = await runAttendingReminders(NOW);

    expect(result.remindersSent).toBe(3);
    expect(await sentCount()).toBe(3);

    const one = await prisma.emailLog.findFirstOrThrow({
      where: { template: "attending-reminder", toEmail: "peggy@yale.edu" },
    });
    // The body carries the whole day's schedule, as the letter always did.
    expect(one.html).toContain("9am-12pm");
    expect(one.html).toContain("Peggy Bia, Frank Bia");
    expect(one.html).toContain("Jack Peng");
  });

  // Someone covering two slots is one person receiving one letter.
  it("sends one email to an attending covering two slots", async () => {
    const target = futureClinicDate(5);
    const term = await createTerm([target]);
    const { morning, midday } = await slots();
    const busy = await attending("Jack Peng", "peng@yale.edu");

    await prisma.clinicDay.create({
      data: {
        termId: term.id,
        clinicDate: target,
        attendings: {
          create: [
            { slotId: morning.id, attendingId: busy.id },
            { slotId: midday.id, attendingId: busy.id },
          ],
        },
      },
    });

    const result = await runAttendingReminders(NOW);
    expect(result.remindersSent).toBe(1);
  });

  it("names the on-call attending, who covers the week AFTER this date", async () => {
    const target = futureClinicDate(5);
    const term = await createTerm([target]);
    const { morning } = await slots();
    const cover = await attending("Rivera", "rivera@yale.edu");
    const onCall = await attending("Peggy Bia", "peggy@yale.edu");

    await prisma.clinicDay.create({
      data: {
        termId: term.id,
        clinicDate: target,
        onCallAttendingId: onCall.id,
        attendings: { create: [{ slotId: morning.id, attendingId: cover.id }] },
      },
    });

    await runAttendingReminders(NOW);

    const log = await prisma.emailLog.findFirstOrThrow({
      where: { template: "attending-reminder", toEmail: "rivera@yale.edu" },
    });
    expect(log.html).toContain("On-Call Attending");
    expect(log.html).toContain("Peggy Bia");
  });

  it("hides the on-call line entirely when nobody holds it", async () => {
    const target = futureClinicDate(5);
    const term = await createTerm([target]);
    const { morning } = await slots();
    const cover = await attending("Rivera", "rivera@yale.edu");
    await prisma.clinicDay.create({
      data: {
        termId: term.id,
        clinicDate: target,
        attendings: { create: [{ slotId: morning.id, attendingId: cover.id }] },
      },
    });

    await runAttendingReminders(NOW);

    const log = await prisma.emailLog.findFirstOrThrow({ where: { template: "attending-reminder" } });
    expect(log.html).not.toContain("On-Call Attending");
  });

  // A "reminder" for a Saturday the clinic is shut would be actively wrong.
  it("sends nothing for a closed clinic date", async () => {
    const target = futureClinicDate(5);
    const term = await createTerm([target]);
    const { morning } = await slots();
    const cover = await attending("Rivera", "rivera@yale.edu");
    await prisma.clinicDay.create({
      data: {
        termId: term.id,
        clinicDate: target,
        isClosed: true,
        attendings: { create: [{ slotId: morning.id, attendingId: cover.id }] },
      },
    });

    expect((await runAttendingReminders(NOW)).remindersSent).toBe(0);
    expect(await sentCount()).toBe(0);
  });

  it("skips an attending with no email on file and reports it", async () => {
    const target = futureClinicDate(5);
    const term = await createTerm([target]);
    const { morning } = await slots();
    const noEmail = await attending("No Email", null);
    await prisma.clinicDay.create({
      data: {
        termId: term.id,
        clinicDate: target,
        attendings: { create: [{ slotId: morning.id, attendingId: noEmail.id }] },
      },
    });

    const result = await runAttendingReminders(NOW);
    expect(result.remindersSent).toBe(0);
    expect(result.skippedNoEmail).toBe(1);
  });

  it("omits a deactivated attending rather than emailing someone who has left", async () => {
    const target = futureClinicDate(5);
    const term = await createTerm([target]);
    const { morning } = await slots();
    const retired = await attending("Retired", "retired@yale.edu", false);
    await prisma.clinicDay.create({
      data: {
        termId: term.id,
        clinicDate: target,
        attendings: { create: [{ slotId: morning.id, attendingId: retired.id }] },
      },
    });

    expect((await runAttendingReminders(NOW)).remindersSent).toBe(0);
  });

  it("is idempotent within the week: a re-run sends nothing", async () => {
    const target = futureClinicDate(5);
    const term = await createTerm([target]);
    const { morning } = await slots();
    const cover = await attending("Rivera", "rivera@yale.edu");
    await prisma.clinicDay.create({
      data: {
        termId: term.id,
        clinicDate: target,
        attendings: { create: [{ slotId: morning.id, attendingId: cover.id }] },
      },
    });

    expect((await runAttendingReminders(NOW)).remindersSent).toBe(1);
    const second = await runAttendingReminders(NOW);
    expect(second.remindersSent).toBe(0);
    expect(second.skippedAlreadySent).toBe(1);
    expect(await sentCount()).toBe(1);
  });

  // Without the bound, a break week points at a future Saturday and re-sends
  // every Monday until it arrives.
  it("sends nothing when the next clinic is beyond this week", async () => {
    const target = futureClinicDate(12);
    const term = await createTerm([target]);
    const { morning } = await slots();
    const cover = await attending("Rivera", "rivera@yale.edu");
    await prisma.clinicDay.create({
      data: {
        termId: term.id,
        clinicDate: target,
        attendings: { create: [{ slotId: morning.id, attendingId: cover.id }] },
      },
    });

    expect((await runAttendingReminders(NOW)).remindersSent).toBe(0);
  });

  it("sends nothing when the day has no attendings scheduled", async () => {
    const target = futureClinicDate(5);
    const term = await createTerm([target]);
    await slots();
    await prisma.clinicDay.create({ data: { termId: term.id, clinicDate: target } });

    expect((await runAttendingReminders(NOW)).remindersSent).toBe(0);
  });
});

describe("the Faculty Relations copy", () => {
  /** The standard case: one covered slot, one director holding the role. */
  async function clinicWithOneAttending() {
    const target = futureClinicDate(5);
    const term = await createTerm([target]);
    const { morning } = await slots();
    const peggy = await attending("Peggy Bia", "peggy@yale.edu");
    await prisma.clinicDay.create({
      data: {
        termId: term.id,
        clinicDate: target,
        attendings: { create: [{ slotId: morning.id, attendingId: peggy.id }] },
      },
    });
    return { term, target };
  }

  it("copies the director on the letter, once, with the body the attendings got", async () => {
    await clinicWithOneAttending();
    await facultyRelationsDirector("Haley Zhang", "haley@yale.edu");

    const result = await runAttendingReminders(NOW);

    expect(result.remindersSent).toBe(1);
    expect(result.copiesSent).toBe(1);

    const copy = await copyTo("haley@yale.edu");
    expect(copy).not.toBeNull();
    // The same letter, not a summary of it: the schedule block is what makes the
    // copy worth having.
    const sent = await prisma.emailLog.findFirstOrThrow({ where: { toEmail: "peggy@yale.edu" } });
    expect(copy!.html).toBe(sent.html);
    // Marked, so it does not read as a shift the director is on.
    expect(copy!.subject).toBe(`Copy: ${sent.subject}`);
  });

  // One copy of the week's letter, not one per covering attending. This is the
  // whole reason it is a copy rather than a Cc header.
  it("sends one copy however many attendings were reminded", async () => {
    const target = futureClinicDate(5);
    const term = await createTerm([target]);
    const { morning, midday } = await slots();
    const peggy = await attending("Peggy Bia", "peggy@yale.edu");
    const frank = await attending("Frank Bia", "frank@yale.edu");
    const peng = await attending("Jack Peng", "peng@yale.edu");
    await prisma.clinicDay.create({
      data: {
        termId: term.id,
        clinicDate: target,
        attendings: {
          create: [
            { slotId: morning.id, attendingId: peggy.id, order: 0 },
            { slotId: morning.id, attendingId: frank.id, order: 1 },
            { slotId: midday.id, attendingId: peng.id },
          ],
        },
      },
    });
    await facultyRelationsDirector("Haley Zhang", "haley@yale.edu");

    const result = await runAttendingReminders(NOW);

    expect(result.remindersSent).toBe(3);
    expect(result.copiesSent).toBe(1);
    expect(
      await prisma.emailLog.count({ where: { toEmail: "haley@yale.edu" } }),
    ).toBe(1);
  });

  it("copies every person holding the role", async () => {
    await clinicWithOneAttending();
    await facultyRelationsDirector("Haley Zhang", "haley@yale.edu");
    await facultyRelationsDirector("Sam Rivera", "sam@yale.edu");

    expect((await runAttendingReminders(NOW)).copiesSent).toBe(2);
    expect(await copyTo("haley@yale.edu")).not.toBeNull();
    expect(await copyTo("sam@yale.edu")).not.toBeNull();
  });

  it("is idempotent within the week, like the reminders themselves", async () => {
    await clinicWithOneAttending();
    await facultyRelationsDirector("Haley Zhang", "haley@yale.edu");

    expect((await runAttendingReminders(NOW)).copiesSent).toBe(1);
    expect((await runAttendingReminders(NOW)).copiesSent).toBe(0);
    expect(await prisma.emailLog.count({ where: { toEmail: "haley@yale.edu" } })).toBe(1);
  });

  // A director who is also on the attending roster already has the letter.
  it("does not copy a director who was reminded as an attending", async () => {
    const target = futureClinicDate(5);
    const term = await createTerm([target]);
    const { morning } = await slots();
    const peggy = await attending("Peggy Bia", "haley@yale.edu");
    await prisma.clinicDay.create({
      data: {
        termId: term.id,
        clinicDate: target,
        attendings: { create: [{ slotId: morning.id, attendingId: peggy.id }] },
      },
    });
    await facultyRelationsDirector("Haley Zhang", "haley@yale.edu");

    const result = await runAttendingReminders(NOW);

    expect(result.remindersSent).toBe(1);
    expect(result.copiesSent).toBe(0);
    expect(await prisma.emailLog.count({ where: { toEmail: "haley@yale.edu" } })).toBe(1);
  });

  // Nothing went out, so there is nothing to copy. A "copy" of a letter no
  // attending received would say a clinic was staffed when it was not.
  it("sends no copy when no attending could be reminded", async () => {
    const target = futureClinicDate(5);
    const term = await createTerm([target]);
    const { morning } = await slots();
    const unreachable = await attending("Peggy Bia", null);
    await prisma.clinicDay.create({
      data: {
        termId: term.id,
        clinicDate: target,
        attendings: { create: [{ slotId: morning.id, attendingId: unreachable.id }] },
      },
    });
    await facultyRelationsDirector("Haley Zhang", "haley@yale.edu");

    const result = await runAttendingReminders(NOW);

    expect(result.skippedNoEmail).toBe(1);
    expect(result.copiesSent).toBe(0);
  });

  it("skips a director with no contact address on file", async () => {
    await clinicWithOneAttending();
    await facultyRelationsDirector("Haley Zhang", null);

    expect((await runAttendingReminders(NOW)).copiesSent).toBe(0);
  });

  // The role follows the person, and an offboarded person no longer holds it.
  it("skips an offboarded director", async () => {
    await clinicWithOneAttending();
    await facultyRelationsDirector("Haley Zhang", "haley@yale.edu", "OFFBOARDED");

    expect((await runAttendingReminders(NOW)).copiesSent).toBe(0);
  });

  // Every other role is somebody else's. Only Faculty Relations is copied.
  it("copies nobody when the role is unassigned", async () => {
    await clinicWithOneAttending();
    const other = await prisma.person.create({
      data: { name: "Alex Admin", contactEmail: "alex@yale.edu" },
    });
    const role = await prisma.role.create({ data: { name: "Platform Admin", isSystem: true } });
    await prisma.roleAssignment.create({ data: { roleId: role.id, personId: other.id } });

    expect((await runAttendingReminders(NOW)).copiesSent).toBe(0);
    expect(await prisma.emailLog.count({ where: { toEmail: "alex@yale.edu" } })).toBe(0);
  });
});
