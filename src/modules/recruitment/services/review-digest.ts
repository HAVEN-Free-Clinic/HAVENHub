import type { CycleStatus } from "@prisma/client";
import { prisma } from "@/platform/db";
import { isoDateKey } from "@/platform/dates";
import { getActiveTerm } from "@/platform/terms/active-term";
import { manageableDepartmentIds } from "@/platform/departments";
import { getSetting } from "@/platform/settings/service";
import { renderEmail } from "@/platform/email/templates/renderEmail";
import { notify } from "@/platform/notifications/notify";
import { claimReminderDispatch } from "@/platform/email/reminder-dispatch";

/**
 * Count applications awaiting a department's review, across both tracks:
 *  - VOLUNTEER: routed to one of `departmentCodes` and still PENDING (the
 *    department decides directly, no interview).
 *  - DIRECTOR: ranked one of `departmentCodes` with no decided interview there
 *    yet (still needs an interview + decision).
 * Only OPEN/CLOSED cycles count; ARCHIVED are done.
 */
export async function pendingReviewCount(departmentCodes: string[]): Promise<number> {
  if (departmentCodes.length === 0) return 0;
  const activeStatus = { in: ["OPEN", "CLOSED"] as CycleStatus[] };
  const codes = new Set(departmentCodes);
  const [volunteer, directorApps] = await Promise.all([
    prisma.application.count({
      where: {
        status: "SUBMITTED",
        decision: "PENDING",
        routedDepartmentCode: { in: departmentCodes },
        cycle: { track: "VOLUNTEER", status: activeStatus },
      },
    }),
    // A single `interviews: { none: {...} }` over the whole department set excluded
    // an application as soon as ANY one of the director's departments had a decided
    // interview -- so a director of A and B stopped seeing an applicant who was
    // decided for A but still needs B. Count per-application: it awaits review when
    // at least one of the director's ranked departments has no decided interview.
    prisma.application.findMany({
      where: {
        status: "SUBMITTED",
        departmentChoices: { hasSome: departmentCodes },
        cycle: { track: "DIRECTOR", status: activeStatus },
      },
      select: {
        departmentChoices: true,
        // decision is a non-nullable enum (default PENDING); `not: "PENDING"` is safe.
        interviews: { where: { decision: { not: "PENDING" } }, select: { departmentCode: true } },
      },
    }),
  ]);
  const director = directorApps.filter((a) => {
    const decided = new Set(a.interviews.map((i) => i.departmentCode));
    return a.departmentChoices.some((d) => codes.has(d) && !decided.has(d));
  }).length;
  return volunteer + director;
}

/**
 * Daily digest: notify each active department director who has applications
 * awaiting review in their department(s). Only sends when the count > 0, so a
 * director with nothing to do is never pinged. Idempotent per (director, day) via
 * claimReminderDispatch, so an at-least-once cron retry or overlapping trigger
 * cannot double-notify. Enqueue-only, like the other cron jobs; delivery is
 * handled by the email/Teams drain.
 */
export async function runRecruitmentReviewDigest(): Promise<{ notified: number; directors: number }> {
  const activeTerm = await getActiveTerm();
  if (!activeTerm) return { notified: 0, directors: 0 };

  const directorIds = [
    ...new Set(
      (
        await prisma.termMembership.findMany({
          where: { termId: activeTerm.id, kind: "DIRECTOR", status: "ACTIVE" },
          select: { personId: true },
        })
      ).map((m) => m.personId),
    ),
  ];

  const baseUrl = await getSetting<string>("app.baseUrl");
  const reviewUrl = `${baseUrl}/recruitment`;
  const periodKey = isoDateKey(new Date());
  let notified = 0;

  for (const personId of directorIds) {
    const deptIds = await manageableDepartmentIds(personId);
    if (deptIds.length === 0) continue;
    const depts = await prisma.department.findMany({ where: { id: { in: deptIds } }, select: { code: true, name: true } });
    const total = await pendingReviewCount(depts.map((d) => d.code));
    if (total === 0) continue;

    const person = await prisma.person.findUnique({
      where: { id: personId },
      select: { id: true, name: true, entraObjectId: true, contactEmail: true },
    });
    if (!person) continue;

    // Claim the (director, day) slot last, so nothing before this consumes it; a
    // failed claim means today's digest already went out to this director.
    if (!(await claimReminderDispatch("recruitment-review-digest", personId, periodKey))) continue;

    const firstName = person.name?.trim().split(/\s+/)[0] || "there";
    const departmentName = depts.map((d) => d.name).join(", ");
    const noun = total === 1 ? "application" : "applications";
    const { subject, html } = await renderEmail("recruitment.review_digest", {
      firstName,
      count: total,
      noun,
      departmentName,
      reviewUrl,
    });
    await notify(prisma, {
      type: "recruitment.review_digest",
      person: { id: person.id, entraObjectId: person.entraObjectId, contactEmail: person.contactEmail },
      email: { subject, html },
      teams: {
        title: `${total} ${noun} to review`,
        summary: `You have ${total} ${noun} awaiting review for ${departmentName}.`,
        link: reviewUrl,
      },
    });
    notified++;
  }

  return { notified, directors: directorIds.length };
}
