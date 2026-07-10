/**
 * Shift request pending reminders.
 * Finds PENDING shift requests older than 48 hours and re-notifies
 * the department directors so requests don't get forgotten.
 *
 * Triggered DAILY by an external scheduler (cron-job.org) hitting this path
 * with Authorization: Bearer $CRON_SECRET. Add to cron-job.org alongside the
 * existing compliance reminders job.
 *
 * Emails go through the shared renderEmail path (branded layout + admin
 * override), and each director is throttled: if they were already sent this
 * template within REMINDER_THROTTLE_MS they are skipped, so a daily cron cannot
 * re-notify the same director every single day a request stays pending. The
 * throttle keys on the same template the original submission notice uses, so it
 * also spaces the first reminder off the initial notification.
 *
 * Only enqueues emails - delivery is handled by the per-minute
 * /api/cron/email route.
 */
import { authorizeCron } from "@/platform/cron";
import { prisma } from "@/platform/db";
import { queueEmail } from "@/platform/email/send";
import { renderEmail } from "@/platform/email/templates/renderEmail";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const REMINDER_TEMPLATE = "schedule-request-submitted-director";

// Skip re-reminding a director who was already sent this template within the
// window. Mirrors the recent-EmailLog dedup in
// src/platform/email/shift-reminders.ts. Three days collapses the daily cron's
// would-be daily duplicates into at most one nudge every few days while a
// request stays pending.
const REMINDER_THROTTLE_MS = 3 * 24 * 60 * 60 * 1000;

export async function GET(req: Request): Promise<Response> {
  if (!authorizeCron(req)) return new Response("Unauthorized", { status: 401 });

  const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000);
  const throttleCutoff = new Date(Date.now() - REMINDER_THROTTLE_MS);

  const pendingRequests = await prisma.shiftRequest.findMany({
    where: {
      status: "PENDING",
      createdAt: { lt: cutoff },
    },
    include: {
      requester: { select: { name: true } },
      target: { select: { name: true } },
      department: { select: { id: true, name: true } },
      term: { select: { id: true } },
    },
  });

  let reminded = 0;
  let skipped = 0;

  for (const pending of pendingRequests) {
    const isSwap = !!(pending.targetId && pending.targetDate);
    const requesterDateStr = pending.requesterDate.toLocaleDateString("en-US", {
      month: "long", day: "numeric", year: "numeric",
    });
    const partnerDateStr = pending.targetDate
      ? pending.targetDate.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })
      : "";

    // Find all directors assigned in this department for the active term.
    const directorAssignments = await prisma.shiftAssignment.findMany({
      where: {
        termId: pending.termId,
        departmentId: pending.departmentId,
        role: "DIRECTOR",
      },
      select: {
        person: { select: { id: true, name: true, contactEmail: true } },
      },
    });

    const uniqueDirectors = new Map<string, { id: string; name: string; contactEmail: string | null }>(
      directorAssignments.map((a) => [a.person.id, a.person])
    );

    for (const director of uniqueDirectors.values()) {
      if (!director.contactEmail) continue;

      // Throttle: skip if this director already got the reminder template within
      // the window (covers both a prior cron reminder AND the original submission
      // notice), so we never enqueue a duplicate every day.
      const already = await prisma.emailLog.findFirst({
        where: {
          personId: director.id,
          template: REMINDER_TEMPLATE,
          createdAt: { gte: throttleCutoff },
        },
        select: { id: true },
      });
      if (already) {
        skipped++;
        continue;
      }

      try {
        const { subject, html } = await renderEmail(REMINDER_TEMPLATE, {
          directorName: director.name?.split(" ")[0] ?? director.name ?? "",
          requesterName: pending.requester.name,
          requestType: isSwap ? "swap" : "drop",
          requesterDate: requesterDateStr,
          partnerName: pending.target?.name ?? "",
          partnerDate: partnerDateStr,
          departmentName: pending.department.name,
        });
        await queueEmail(prisma, {
          to: director.contactEmail,
          subject,
          html,
          template: REMINDER_TEMPLATE,
          personId: director.id,
          triggeredById: director.id,
        });
        reminded++;
      } catch {
        // Best-effort.
      }
    }
  }

  return Response.json({ ok: true, reminded, skipped });
}
