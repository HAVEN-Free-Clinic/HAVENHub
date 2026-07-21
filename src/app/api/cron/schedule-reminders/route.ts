/**
 * Shift request pending reminders.
 * Finds PENDING shift requests older than 48 hours and re-notifies the
 * department's ACTUAL approvers so requests don't get forgotten.
 *
 * Recipients come from requestApproverRecipients() -- the same set
 * createRequest/approveRequest/remindDirectors use (directors by ACTIVE
 * membership + one-hop delegated directors + in-department
 * schedule.manage_requests holders) -- NOT merely whoever holds a DIRECTOR shift
 * on the calendar, which missed membership-only and delegated approvers and
 * sometimes reminded nobody (audit M3).
 *
 * Triggered DAILY by an external scheduler (cron-job.org) hitting this path
 * with Authorization: Bearer $CRON_SECRET. Add to cron-job.org alongside the
 * existing compliance reminders job.
 *
 * Emails go through the shared renderEmail path (branded layout + admin
 * override), and each approver is throttled: if they were already sent this
 * template within REMINDER_THROTTLE_MS they are skipped, so a daily cron cannot
 * re-notify the same approver every single day a request stays pending. The
 * throttle keys on the same template the original submission notice uses, so it
 * also spaces the first reminder off the initial notification.
 *
 * Only enqueues emails - delivery is handled by the per-minute
 * /api/cron/email route.
 */
import { authorizeCron } from "@/platform/cron";
import { recordCronHeartbeat } from "@/platform/cron-heartbeat";
import { prisma } from "@/platform/db";
import { log, flushLogs } from "@/platform/logging";
import { queueEmail } from "@/platform/email/send";
import { renderEmail } from "@/platform/email/templates/renderEmail";
import { requestApproverRecipients } from "@/modules/schedule/services/requests";
import { isoDateKey, formatCalendarDate } from "@/platform/dates";
import { claimReminderDispatch, releaseReminderDispatch } from "@/platform/email/reminder-dispatch";

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
  // UTC day key used as the atomic per-day claim scope (below).
  const todayKey = isoDateKey(new Date());

  const pendingRequests = await prisma.shiftRequest.findMany({
    where: {
      status: "PENDING",
      createdAt: { lt: cutoff },
    },
    include: {
      requester: { select: { name: true } },
      target: { select: { name: true } },
      department: { select: { name: true } },
    },
  });

  // Approver recipients are per-department and stable across this run, so memoize
  // to avoid re-running the (permission-checking) query for every pending request
  // that shares a department.
  const approverCache = new Map<
    string,
    Array<{ id: string; name: string; contactEmail: string | null }>
  >();
  async function approversForDept(departmentId: string) {
    const cached = approverCache.get(departmentId);
    if (cached) return cached;
    const recipients = await requestApproverRecipients(departmentId);
    approverCache.set(departmentId, recipients);
    return recipients;
  }

  let reminded = 0;
  let skipped = 0;

  for (const pending of pendingRequests) {
    const isSwap = !!(pending.targetId && pending.targetDate);
    const requesterDateStr = formatCalendarDate(pending.requesterDate, {
      month: "long", day: "numeric", year: "numeric",
    });
    const partnerDateStr = pending.targetDate
      ? formatCalendarDate(pending.targetDate, { month: "long", day: "numeric", year: "numeric" })
      : "";

    // The department's actual approvers: directors by ACTIVE membership, one-hop
    // delegated directors, and in-department schedule.manage_requests holders --
    // the same set that can decide this request. Deduped by person already.
    const approvers = await approversForDept(pending.departmentId);

    for (const approver of approvers) {
      if (!approver.contactEmail) continue;

      // Throttle: skip if this approver already got the reminder template within
      // the window (covers both a prior cron reminder AND the original submission
      // notice), so we never enqueue a duplicate every day.
      const already = await prisma.emailLog.findFirst({
        where: {
          personId: approver.id,
          template: REMINDER_TEMPLATE,
          createdAt: { gte: throttleCutoff },
        },
        select: { id: true },
      });
      if (already) {
        skipped++;
        continue;
      }

      // Atomic per-day claim so two overlapping daily runs cannot both enqueue the
      // same approver's reminder. The 3-day EmailLog throttle above still governs
      // day-to-day spacing; this only guards same-tick concurrency and per-run
      // dedup across an approver's multiple pending requests.
      const claimed = await claimReminderDispatch("schedule-request-reminder", approver.id, todayKey);
      if (!claimed) {
        skipped++;
        continue;
      }

      try {
        const { subject, html } = await renderEmail(REMINDER_TEMPLATE, {
          directorName: approver.name?.split(" ")[0] ?? approver.name ?? "",
          requesterName: pending.requester.name,
          requestType: isSwap ? "swap" : "drop",
          requesterDate: requesterDateStr,
          partnerName: pending.target?.name ?? "",
          partnerDate: partnerDateStr,
          departmentName: pending.department.name,
        });
        await queueEmail(prisma, {
          to: approver.contactEmail,
          subject,
          html,
          template: REMINDER_TEMPLATE,
          personId: approver.id,
          triggeredById: approver.id,
        });
        reminded++;
      } catch (err) {
        // Release the per-day claim (taken before this enqueue) so a failed reminder
        // retries next tick instead of being silently suppressed by the marker, and
        // surface it rather than swallowing.
        await releaseReminderDispatch("schedule-request-reminder", approver.id, todayKey);
        log.warn("[cron/schedule-reminders] failed to enqueue reminder", {
          personId: approver.id,
          requestId: pending.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  log.info("[cron/schedule-reminders] complete", { reminded, skipped });
  await recordCronHeartbeat("schedule-reminders");
  await flushLogs();
  return Response.json({ ok: true, reminded, skipped });
}
