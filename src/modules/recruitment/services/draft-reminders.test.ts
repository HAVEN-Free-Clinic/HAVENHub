import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { runDraftReminders } from "./draft-reminders";

const NOW = new Date("2026-09-05T13:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

async function seedDraft(opts: { closesInDays?: number | null; updatedDaysAgo?: number; routineCount?: number; finalCount?: number } = {}) {
  const creator = await prisma.person.create({ data: { name: "Cycle Owner", status: "ACTIVE" } });
  const term = await prisma.term.create({
    data: {
      code: `T${Math.random().toString(36).slice(2, 7)}`,
      name: "Test term",
      startDate: new Date("2026-01-01T12:00:00Z"),
      endDate: new Date("2026-12-31T12:00:00Z"),
      clinicDates: [new Date("2026-10-03T12:00:00Z")],
    },
  });
  const cycle = await prisma.recruitmentCycle.create({
    data: {
      track: "VOLUNTEER",
      termId: term.id,
      title: "Fall volunteers",
      publicSlug: `fall-${Math.random().toString(36).slice(2, 7)}`,
      departments: [],
      createdById: creator.id,
      status: "OPEN",
      closesAt: opts.closesInDays === null ? null : new Date(NOW.getTime() + (opts.closesInDays ?? 30) * DAY),
    },
  });
  const personal = await prisma.formSection.create({
    data: { cycleId: cycle.id, title: "Personal details", order: 0, appliesTo: "BOTH", purpose: "APPLICATION" },
  });
  const resume = await prisma.formSection.create({
    data: { cycleId: cycle.id, title: "Resume", order: 1, appliesTo: "BOTH", purpose: "APPLICATION" },
  });
  await prisma.formField.createMany({
    data: [
      { sectionId: personal.id, cycleId: cycle.id, key: "first_name", label: "First name", type: "SHORT_TEXT", required: true, order: 0 },
      { sectionId: resume.id, cycleId: cycle.id, key: "resume", label: "Resume", type: "FILE", required: true, order: 0 },
    ],
  });
  const applicant = await prisma.applicant.create({
    data: { cycleId: cycle.id, firstName: "", lastName: "", email: "ada@example.org", emailLower: "ada@example.org" },
  });
  const application = await prisma.application.create({
    data: {
      cycleId: cycle.id,
      applicantId: applicant.id,
      answers: { first_name: "Ada" },
      applicantType: "NEW",
      departmentChoices: [],
      status: "DRAFT",
      draftReminderCount: opts.routineCount ?? 0,
      draftFinalReminderCount: opts.finalCount ?? 0,
    },
  });
  const updatedAt = new Date(NOW.getTime() - (opts.updatedDaysAgo ?? 3) * DAY);
  await prisma.application.update({ where: { id: application.id }, data: { updatedAt } });
  return { cycle, application: { ...application, updatedAt } };
}

beforeEach(async () => { await resetDb(); });
afterEach(async () => { await resetDb(); });

describe("runDraftReminders", () => {
  it("queues a progress-aware routine reminder and preserves applicant activity time", async () => {
    const { cycle, application } = await seedDraft();
    const result = await runDraftReminders(NOW);
    expect(result).toMatchObject({ considered: 1, routineSent: 1, finalSent: 0, failed: 0 });

    const row = await prisma.application.findUniqueOrThrow({ where: { id: application.id } });
    expect(row.draftReminderCount).toBe(1);
    expect(row.draftReminderLastSentAt).toEqual(NOW);
    expect(row.updatedAt).toEqual(application.updatedAt);

    const mail = await prisma.emailLog.findFirstOrThrow({ where: { template: "recruitment.draft_reminder" } });
    expect(mail.toEmail).toBe("ada@example.org");
    expect(mail.subject).toContain("still unfinished");
    expect(mail.html).toContain("Ada");
    expect(mail.html).toContain("Resume");
    expect(mail.html).toContain("1 of 2 steps");
    expect(mail.html).toContain(encodeURIComponent(`/apply/${cycle.publicSlug}`));
  });

  it("is atomic and idempotent when two cron runs overlap", async () => {
    const { application } = await seedDraft();
    const [a, b] = await Promise.all([runDraftReminders(NOW), runDraftReminders(NOW)]);
    expect(a.routineSent + b.routineSent).toBe(1);
    expect(await prisma.emailLog.count({ where: { template: "recruitment.draft_reminder" } })).toBe(1);
    expect((await prisma.application.findUniqueOrThrow({ where: { id: application.id } })).draftReminderCount).toBe(1);
  });

  it("sends the final stream even after the routine budget is exhausted", async () => {
    const { application } = await seedDraft({ closesInDays: 7, routineCount: 3 });
    const result = await runDraftReminders(NOW);
    expect(result).toMatchObject({ routineSent: 0, finalSent: 1 });
    const row = await prisma.application.findUniqueOrThrow({ where: { id: application.id } });
    expect(row.draftReminderCount).toBe(3);
    expect(row.draftFinalReminderCount).toBe(1);
    const mail = await prisma.emailLog.findFirstOrThrow({ where: { template: "recruitment.draft_reminder" } });
    expect(mail.subject).toContain("Applications close");
  });

  it("does not remind a recently active or submitted application", async () => {
    const recent = await seedDraft({ updatedDaysAgo: 1 });
    expect((await runDraftReminders(NOW)).routineSent).toBe(0);
    await prisma.application.update({ where: { id: recent.application.id }, data: { status: "SUBMITTED", submittedAt: NOW } });
    expect((await runDraftReminders(new Date(NOW.getTime() + 10 * DAY))).considered).toBe(0);
    expect(await prisma.emailLog.count({ where: { template: "recruitment.draft_reminder" } })).toBe(0);
  });
});
