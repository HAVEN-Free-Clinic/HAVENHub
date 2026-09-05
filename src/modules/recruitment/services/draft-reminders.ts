import { prisma } from "@/platform/db";
import { formatDateTime } from "@/platform/dates";
import { getDisplayTimeZone } from "@/platform/dates/resolve";
import { queueEmail } from "@/platform/email/send";
import { draftReminderContext } from "@/platform/email/templates/recruitment";
import { errorAttrs, log } from "@/platform/logging";
import { firstNameOf } from "@/platform/person-name";
import { dueDraftReminder, type DraftReminderKind } from "../engine/draft-reminder-cadence";
import { renderResolvedEmail, resolveCycleEmail } from "../email/render";
import { progressFor, selectedDepartmentsFrom } from "./draft-progress";
import { resolveAvailabilityOptions } from "../templates/clinic-dates";
import { resolveSectionTitle } from "../templates/department-options";
import { portalUrl } from "./portal-url";

export type DraftReminderRunResult = {
  considered: number;
  routineSent: number;
  finalSent: number;
  skipped: number;
  failed: number;
};

/** The reminder intentionally opens the sign-in surface first. It carries a
 * safe, same-origin next path so either Yale SSO or email magic-link sign-in
 * returns the applicant directly to this cycle's saved draft. */
export async function draftReminderUrl(slug: string): Promise<string> {
  const url = new URL(await portalUrl());
  url.searchParams.set("next", `/apply/${slug}`);
  return url.toString();
}

/**
 * Atomically claim one application reminder and enqueue its email.
 *
 * Raw SQL is deliberate here: Prisma's @updatedAt machinery would make the
 * reminder itself look like applicant activity. That would corrupt the useful
 * "last touched" signal, distort abandonment reporting, and postpone cleanup.
 * The optimistic predicates also mean an autosave, submit, or overlapping cron
 * that wins first makes this claim affect zero rows and no email is queued.
 */
async function claimAndQueue(input: {
  applicationId: string;
  expectedUpdatedAt: Date;
  expectedLastSentAt: Date | null;
  expectedRoutineCount: number;
  expectedFinalCount: number;
  kind: DraftReminderKind;
  to: string;
  subject: string;
  html: string;
  now: Date;
}): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const common = input.kind === "routine"
      ? await tx.$executeRaw`
          UPDATE "Application"
          SET "draftReminderCount" = "draftReminderCount" + 1,
              "draftReminderLastSentAt" = ${input.now}
          WHERE "id" = ${input.applicationId}
            AND "status" = 'DRAFT'::"ApplicationStatus"
            AND "updatedAt" = ${input.expectedUpdatedAt}
            AND "draftReminderCount" = ${input.expectedRoutineCount}
            AND "draftFinalReminderCount" = ${input.expectedFinalCount}
            AND "draftReminderLastSentAt" IS NOT DISTINCT FROM ${input.expectedLastSentAt}
        `
      : await tx.$executeRaw`
          UPDATE "Application"
          SET "draftFinalReminderCount" = "draftFinalReminderCount" + 1,
              "draftReminderLastSentAt" = ${input.now}
          WHERE "id" = ${input.applicationId}
            AND "status" = 'DRAFT'::"ApplicationStatus"
            AND "updatedAt" = ${input.expectedUpdatedAt}
            AND "draftReminderCount" = ${input.expectedRoutineCount}
            AND "draftFinalReminderCount" = ${input.expectedFinalCount}
            AND "draftReminderLastSentAt" IS NOT DISTINCT FROM ${input.expectedLastSentAt}
        `;
    if (common !== 1) return false;
    await queueEmail(tx, {
      to: input.to,
      subject: input.subject,
      html: input.html,
      template: "recruitment.draft_reminder",
    });
    return true;
  });
}

/** Daily, deadline-aware reminder pass for every unsubmitted application. */
export async function runDraftReminders(now: Date = new Date()): Promise<DraftReminderRunResult> {
  const quietCutoff = new Date(now.getTime() - 20 * 60 * 60 * 1000);
  const cycles = await prisma.recruitmentCycle.findMany({
    where: {
      status: "OPEN",
      AND: [
        { OR: [{ opensAt: null }, { opensAt: { lte: now } }] },
        { OR: [{ closesAt: null }, { closesAt: { gte: now } }] },
      ],
      applications: { some: { status: "DRAFT", updatedAt: { lte: quietCutoff } } },
    },
    select: {
      id: true,
      title: true,
      publicSlug: true,
      status: true,
      opensAt: true,
      closesAt: true,
      departments: true,
      term: {
        select: {
          clinicDates: true,
          clinicDays: { where: { isClosed: true }, select: { clinicDate: true } },
        },
      },
      sections: {
        where: { purpose: "APPLICATION" },
        orderBy: { order: "asc" },
        select: {
          id: true,
          title: true,
          appliesTo: true,
          departmentCode: true,
          fields: {
            orderBy: { order: "asc" },
            select: { key: true, required: true, type: true, options: true, visibleWhen: true, validation: true },
          },
        },
      },
      applications: {
        where: { status: "DRAFT", updatedAt: { lte: quietCutoff } },
        orderBy: { updatedAt: "asc" },
        select: {
          id: true,
          status: true,
          answers: true,
          applicantType: true,
          updatedAt: true,
          draftReminderCount: true,
          draftFinalReminderCount: true,
          draftReminderLastSentAt: true,
          applicant: {
            select: {
              email: true,
              firstName: true,
              applicantPerson: { select: { name: true } },
            },
          },
        },
      },
    },
  });

  const departmentCodes = [...new Set(cycles.flatMap((cycle) => cycle.departments))];
  const departments = departmentCodes.length
    ? await prisma.department.findMany({ where: { code: { in: departmentCodes } }, select: { code: true, name: true } })
    : [];
  const zone = await getDisplayTimeZone();
  const result: DraftReminderRunResult = { considered: 0, routineSent: 0, finalSent: 0, skipped: 0, failed: 0 };

  for (const cycle of cycles) {
    const closed = new Set(cycle.term.clinicDays.map((day) => day.clinicDate.getTime()));
    const openDates = cycle.term.clinicDates.filter((date) => !closed.has(date.getTime()));
    const sections = resolveAvailabilityOptions(cycle.sections, openDates);
    const fields = sections.flatMap((section) => section.fields);
    const sources = await resolveCycleEmail(cycle.id, "recruitment.draft_reminder");
    const applyUrl = await draftReminderUrl(cycle.publicSlug);
    const deadline = cycle.closesAt
      ? formatDateTime(cycle.closesAt, zone, { weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" })
      : null;

    for (const application of cycle.applications) {
      result.considered += 1;
      const kind = dueDraftReminder({
        status: application.status,
        cycleStatus: cycle.status,
        opensAt: cycle.opensAt,
        closesAt: cycle.closesAt,
        updatedAt: application.updatedAt,
        lastSentAt: application.draftReminderLastSentAt,
        routineCount: application.draftReminderCount,
        finalCount: application.draftFinalReminderCount,
      }, now);
      if (!kind) {
        result.skipped += 1;
        continue;
      }

      try {
        const answers = (application.answers as Record<string, unknown>) ?? {};
        const progress = progressFor({
          sections: sections.map((section) => ({
            id: section.id,
            title: resolveSectionTitle(section, departments),
            appliesTo: section.appliesTo,
            departmentCode: section.departmentCode,
            fields: section.fields,
          })),
          answers,
          applicantType: application.applicantType,
          selectedDepartmentCodes: selectedDepartmentsFrom(answers, fields),
        });
        const answerFirstName = typeof answers.first_name === "string" ? answers.first_name.trim() : "";
        const firstName = application.applicant.firstName.trim()
          || answerFirstName
          || firstNameOf(application.applicant.applicantPerson?.name)
          || "there";
        const context = draftReminderContext({
          firstName,
          cycleTitle: cycle.title,
          tier: progress.tier,
          remainingSteps: progress.remaining.map((step) => step.title),
          completedCount: progress.completedCount,
          totalCount: progress.totalCount,
          deadline,
          closingSoon: kind === "final",
          applyUrl,
        });
        const email = renderResolvedEmail(sources, context);
        const claimed = await claimAndQueue({
          applicationId: application.id,
          expectedUpdatedAt: application.updatedAt,
          expectedLastSentAt: application.draftReminderLastSentAt,
          expectedRoutineCount: application.draftReminderCount,
          expectedFinalCount: application.draftFinalReminderCount,
          kind,
          to: application.applicant.email,
          subject: email.subject,
          html: email.html,
          now,
        });
        if (!claimed) {
          result.skipped += 1;
          continue;
        }
        if (kind === "routine") result.routineSent += 1;
        else result.finalSent += 1;
      } catch (error) {
        result.failed += 1;
        log.error("[draft-reminders] failed to queue applicant reminder", errorAttrs(error, {
          applicationId: application.id,
          cycleId: cycle.id,
        }));
      }
    }
  }

  return result;
}
