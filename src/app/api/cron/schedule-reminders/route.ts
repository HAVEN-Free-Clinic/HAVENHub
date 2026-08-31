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
 * The same run also sends the Executive Directors a DIGEST, grouped by
 * department (sendExecutiveDigest below). They are not approvers, so copying
 * them on the per-department email would be both wrong and useless: the
 * per-person daily claim would hand each ED exactly one of those emails a day,
 * about one department, and silently drop the rest. One digest gives them the
 * whole picture for the cost of one claim.
 *
 * The digest is filtered on its OWN bar, not the approver cadence: the coming
 * clinic week at any age, plus anything untouched for DIGEST_STALE_DAYS (see
 * engine/request-digest.ts). So the two lists overlap without either containing
 * the other, and a same-week request reaches the EDs before it has aged into
 * even its department's first reminder.
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
  byUrgencyThenDate,
  cadenceFor,
  isRemindable,
  reminderUrgency,
} from "@/modules/schedule/engine/request-reminder-cadence";
import {
  DIGEST_STALE_DAYS,
  belongsInDigest,
  buildRequestDigest,
  type DigestEntry,
} from "@/modules/schedule/engine/request-digest";
import { departmentDirectorPersonIds } from "@/platform/departments";
import { isoDateKey, formatCalendarDate } from "@/platform/dates";
import { displayTodayKey } from "@/platform/dates/today";
import { firstNameOf } from "@/platform/person-name";
import { claimReminderDispatch, releaseReminderDispatch } from "@/platform/email/reminder-dispatch";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const REMINDER_TEMPLATE = "schedule-request-submitted-director";
const DIGEST_TEMPLATE = "schedule-request-digest-exec";
/**
 * Its own claim kind, so an ED who is ALSO a department director still gets
 * both emails: the per-department reminder is a request they can decide, the
 * digest is everything they are watching. Sharing a kind would let whichever
 * ran first silence the other.
 */
const DIGEST_CLAIM = "schedule-request-exec-digest";
/**
 * The Executive Directors are the directors of the EXEC department, the same
 * derivation the shift reminder and triage chat code uses. Hardcoded rather
 * than a setting: no other department is the clinic's escalation path, and a
 * mistyped code would silently send nothing.
 */
const EXEC_DEPARTMENT_CODE = "EXEC";

/** The long form every date in these emails uses. */
function longDate(d: Date): string {
  return formatCalendarDate(d, { month: "long", day: "numeric", year: "numeric" });
}

export async function GET(req: Request): Promise<Response> {
  if (!authorizeCron(req)) return new Response("Unauthorized", { status: 401 });

  const now = Date.now();
  // UTC day key used as the atomic per-day claim scope (below).
  const todayKey = isoDateKey(new Date());
  // Urgency is a calendar-day question ("is this clinic within a week?"), so it
  // is measured in the DISPLAY zone. A raw UTC key rolls over around 8pm ET and
  // would call a request urgent a few hours early each evening.
  const displayToday = await displayTodayKey();

  // Every live pending request, with NO age floor in the query. There used to be
  // one (the loosest cadence minAge, 12 hours), and it cannot survive the
  // Executive Director digest: its clinic-week lane escalates a request at any
  // age, so an age-bounded query would silently hide a same-week drop filed this
  // morning. Both audiences re-filter below against their own bar, so the
  // approver reminders are unaffected; the query just returns a few more rows.
  const rawPending = await prisma.shiftRequest.findMany({
    where: {
      status: "PENDING",
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

  // Tag each request with how pressing it is and how long it has sat, then put
  // the most pressing first: the cron takes at most one per-day dispatch claim
  // per approver, so whichever request reaches an approver first is the one they
  // actually hear about today. The digest inherits this order too, so the
  // department with the most urgent request heads its list.
  const tagged = rawPending
    .map((pending) => {
      const requesterDateKey = isoDateKey(pending.requesterDate);
      return {
        pending,
        requesterDateKey,
        urgency: reminderUrgency({ requesterDateKey, todayKey: displayToday }),
        ageMs: now - pending.createdAt.getTime(),
      };
    })
    .sort(byUrgencyThenDate);

  // The two audiences filter the same tagged list against DIFFERENT bars, which
  // is the point: approvers are chased on their request's own cadence, while the
  // EDs hear only about the coming week and the genuinely stuck (see
  // belongsInDigest). Neither list is a subset of the other.
  const pendingRequests = tagged.filter(isRemindable);
  const digestRequests = tagged.filter(belongsInDigest);

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
    const requesterDateStr = longDate(pending.requesterDate);
    const partnerDateStr = pending.targetDate ? longDate(pending.targetDate) : "";

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
          directorName: firstNameOf(approver.name),
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

  // The EDs' roll-up: everything inside the coming clinic week, plus anything
  // nobody has touched in DIGEST_STALE_DAYS.
  const digested = await sendExecutiveDigest(
    digestRequests.map(({ pending, urgency, ageMs }) => ({
      departmentId: pending.departmentId,
      departmentName: pending.department.name,
      requesterName: pending.requester.name,
      requesterDate: longDate(pending.requesterDate),
      partner:
        pending.targetId && pending.targetDate
          ? { name: pending.target?.name ?? "", date: longDate(pending.targetDate) }
          : null,
      urgency,
      ageMs,
    })),
    todayKey,
  );

  log.info("[cron/schedule-reminders] complete", { reminded, skipped, digested });
  await recordCronHeartbeat("schedule-reminders");
  await flushLogs();
  return Response.json({ ok: true, reminded, skipped, digested });
}

/**
 * Email the Executive Directors one digest of every request that has reached
 * the escalation bar.
 *
 * Sends nothing when there is nothing overdue: an ED opening a mail that says
 * "0 requests pending" every morning learns to ignore the subject line, and the
 * one morning it matters they ignore that one too.
 *
 * Claimed per ED per day like every other reminder here, so two overlapping
 * runs cannot both send it, and released on a failed enqueue so a render error
 * retries tomorrow instead of being suppressed forever by a marker.
 *
 * Returns the number of digests actually enqueued.
 */
async function sendExecutiveDigest(entries: DigestEntry[], todayKey: string): Promise<number> {
  if (entries.length === 0) return 0;

  const exec = await prisma.department.findUnique({
    where: { code: EXEC_DEPARTMENT_CODE },
    select: { id: true },
  });
  // A clinic that has not created the EXEC department (or a fresh test database)
  // simply has no digest recipients. Not an error: the per-approver reminders
  // above are the load-bearing half of this job and have already gone out.
  if (!exec) return 0;

  const execIds = await departmentDirectorPersonIds(exec.id);
  if (execIds.length === 0) return 0;

  const eds = await prisma.person.findMany({
    where: { id: { in: execIds } },
    select: { id: true, name: true, contactEmail: true },
  });

  const { pendingSummary, requestList } = buildRequestDigest(entries);
  const urls = await scheduleEmailUrls();

  let sent = 0;
  for (const ed of eds) {
    if (!ed.contactEmail) continue;

    const claimed = await claimReminderDispatch(DIGEST_CLAIM, ed.id, todayKey);
    if (!claimed) continue;

    try {
      const { subject, html } = await renderEmail(DIGEST_TEMPLATE, {
        ...urls,
        directorName: firstNameOf(ed.name),
        pendingSummary,
        requestList,
        // So the email's own explanation of why a request is on the list stays
        // true if the escalation threshold is ever retuned.
        escalationDays: DIGEST_STALE_DAYS,
      });
      await queueEmail(prisma, {
        to: ed.contactEmail,
        subject,
        html,
        template: DIGEST_TEMPLATE,
        personId: ed.id,
        triggeredById: ed.id,
      });
      sent++;
    } catch (err) {
      await releaseReminderDispatch(DIGEST_CLAIM, ed.id, todayKey);
      log.warn("[cron/schedule-reminders] failed to enqueue executive digest", {
        personId: ed.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return sent;
}
