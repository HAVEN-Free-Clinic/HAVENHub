/**
 * Shift request pending reminders.
 * Finds PENDING shift requests that have aged into their reminder cadence and
 * re-notifies the department's ACTUAL approvers so requests don't get forgotten.
 *
 * The cadence is urgency-aware (see engine/request-reminder-cadence.ts): a
 * request for a clinic within the next week is remindable after 12 hours and
 * re-sent daily, while everything else keeps the original 48-hour / 3-day
 * spacing. This is what makes the job useful for last-minute drops, which the
 * flat 48-hour rule reliably missed -- the clinic had already happened by the
 * time the first reminder was due.
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
 * override), and each approver is throttled by their request's cadence: if they
 * were already sent this template inside that window they are skipped, so the
 * daily cron cannot re-notify the same approver more often than the cadence
 * allows. The throttle keys on the same template the original submission notice
 * uses, so it also spaces the first reminder off the initial notification.
 *
 * Requests are processed most-urgent-first because the per-day dispatch claim
 * below admits at most ONE reminder per approver per day: the ordering decides
 * which request that one email is about.
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
import { requestApproverRecipients, scheduleEmailUrls } from "@/modules/schedule/services/requests";
import {
  CADENCE,
  byUrgencyThenDate,
  cadenceFor,
  isRemindable,
  reminderUrgency,
} from "@/modules/schedule/engine/request-reminder-cadence";
import { isoDateKey, formatCalendarDate } from "@/platform/dates";
import { displayTodayKey } from "@/platform/dates/today";
import { claimReminderDispatch, releaseReminderDispatch } from "@/platform/email/reminder-dispatch";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const REMINDER_TEMPLATE = "schedule-request-submitted-director";

export async function GET(req: Request): Promise<Response> {
  if (!authorizeCron(req)) return new Response("Unauthorized", { status: 401 });

  const now = Date.now();
  // The LOOSEST age any cadence uses. Each request is then re-filtered against
  // its own cadence below, so a normal-cadence request still waits its 48 hours.
  const widestCutoff = new Date(
    now - Math.min(...Object.values(CADENCE).map((c) => c.minAgeMs)),
  );
  // UTC day key used as the atomic per-day claim scope (below).
  const todayKey = isoDateKey(new Date());
  // Urgency is a calendar-day question ("is this clinic within a week?"), so it
  // is measured in the DISPLAY zone. A raw UTC key rolls over around 8pm ET and
  // would call a request urgent a few hours early each evening.
  const displayToday = await displayTodayKey();

  const rawPending = await prisma.shiftRequest.findMany({
    where: {
      status: "PENDING",
      createdAt: { lt: widestCutoff },
      // A request whose term has been archived can no longer be decided anywhere
      // in the app (the approval surfaces span ACTIVE + published PLANNING), so
      // reminding approvers about it is a dead-end nag that recurs forever. Skip
      // archived-term requests; the live and next terms are still reminded.
      // status is a non-nullable enum, so `not` drops no rows unexpectedly.
      term: { status: { not: "ARCHIVED" } },
    },
    include: {
      requester: { select: { name: true } },
      target: { select: { name: true } },
      department: { select: { name: true } },
    },
  });

  // Tag each request with its cadence, drop the ones not yet old enough for
  // theirs, and put the most pressing first: the cron takes at most one per-day
  // dispatch claim per approver, so whichever request reaches an approver first
  // is the one they actually hear about today.
  const pendingRequests = rawPending
    .map((pending) => {
      const requesterDateKey = isoDateKey(pending.requesterDate);
      return {
        pending,
        requesterDateKey,
        urgency: reminderUrgency({ requesterDateKey, todayKey: displayToday }),
      };
    })
    .filter((r) => isRemindable({ urgency: r.urgency, ageMs: now - r.pending.createdAt.getTime() }))
    .sort(byUrgencyThenDate);

  // Approver recipients are per-department and per-term, so memoize to avoid
  // re-running the (permission-checking) query for every pending request that
  // shares a department and term. Key on ${departmentId}|${termId}.
  const approverCache = new Map<
    string,
    Array<{ id: string; name: string; contactEmail: string | null }>
  >();
  async function approversFor(departmentId: string, termId: string) {
    const key = `${departmentId}|${termId}`;
    const cached = approverCache.get(key);
    if (cached) return cached;
    const recipients = await requestApproverRecipients(departmentId, termId);
    approverCache.set(key, recipients);
    return recipients;
  }

  let reminded = 0;
  let skipped = 0;

  for (const { pending, urgency } of pendingRequests) {
    const throttleCutoff = new Date(now - cadenceFor(urgency).throttleMs);
    const isSwap = !!(pending.targetId && pending.targetDate);
    const requesterDateStr = formatCalendarDate(pending.requesterDate, {
      month: "long", day: "numeric", year: "numeric",
    });
    const partnerDateStr = pending.targetDate
      ? formatCalendarDate(pending.targetDate, { month: "long", day: "numeric", year: "numeric" })
      : "";

    // The department's actual approvers for this request's term: directors by
    // ACTIVE membership, one-hop delegated directors, and in-department
    // schedule.manage_requests holders -- the same set that can decide this
    // request. Deduped by person already.
    const approvers = await approversFor(pending.departmentId, pending.termId);

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
          // Without these the template's "Review pending requests" CTA rendered
          // as <a href=""> in every daily reminder (audit 14).
          ...(await scheduleEmailUrls()),
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
