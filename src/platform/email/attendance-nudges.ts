/**
 * The check-in nudge: "we recorded your attendance, but your onboarding is not
 * finished, so it cannot be credited yet."
 *
 * Two entry points over one send path:
 *   - sendAttendanceNudge, called once from the check-in itself, so the message
 *     lands while the attendee still remembers walking in.
 *   - runAttendanceNudges, the recurring pass, because a single fire-and-forget
 *     email at a door is not a follow-up. It re-measures what is outstanding
 *     each time rather than replaying the check-in snapshot, so a member who has
 *     since uploaded their HIPAA certificate is told about what is left, and one
 *     who has finished everything is dropped from the stream.
 *
 * Both share the reminder engine's claim discipline (see ./reminders.ts): the
 * interval predicate lives in the WHERE of an updateMany, so two overlapping
 * runs cannot both send, and the claim is taken BEFORE the send -- a lost nudge
 * on a mid-run crash is recovered next interval, a duplicate never is.
 */

import { prisma } from "@/platform/db";
import { getSetting } from "@/platform/settings/service";
import { log, errorAttrs } from "@/platform/logging";
import { notify } from "@/platform/notifications/notify";
import { resolveChannel } from "@/platform/notifications/channel";
import { getDisplayTimeZone } from "@/platform/dates/resolve";
import { formatDateTime } from "@/platform/dates";
import {
  resolveBlockersFor,
  WALK_UP_BLOCKERS,
  type AttendanceBlockers,
} from "@/platform/compliance/attendance-blockers";
import { queueEmail } from "./send";
import { renderEmail } from "./templates/renderEmail";
import { attendanceNudgeContext } from "./templates/attendance";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * How many times one attendance row is chased before the stream gives up.
 *
 * Three at the default 7-day interval is three weeks of asking, which is where
 * the clearance digest's overdue threshold also lands (DIGEST_STALLED_FLAG_DAYS).
 * Past that, someone who attended and never onboarded is a conversation for a
 * director, not another email -- and the row stays visible on the event page
 * either way, so nothing is lost by stopping.
 */
export const MAX_ATTENDANCE_NUDGES = 3;

/**
 * How far back the recurring pass looks. An attendance row from two terms ago
 * whose blockers never cleared is history, not an open loop, and chasing it
 * would mail people about a session they have long forgotten.
 */
const NUDGE_LOOKBACK_DAYS = 120;

type NudgeRow = {
  id: string;
  personId: string | null;
  attendeeName: string | null;
  attendeeEmail: string | null;
  event: { title: string; startsAt: Date; termId: string };
  person: { id: string; name: string; contactEmail: string | null; entraObjectId: string | null } | null;
};

const NUDGE_SELECT = {
  id: true,
  personId: true,
  attendeeName: true,
  attendeeEmail: true,
  event: { select: { title: true, startsAt: true, termId: true } },
  person: { select: { id: true, name: true, contactEmail: true, entraObjectId: true } },
} as const;

/** Live blockers for one row: recomputed for a member, fixed for a walk-up. */
async function liveBlockers(row: NudgeRow, now: Date): Promise<AttendanceBlockers> {
  if (!row.personId) return WALK_UP_BLOCKERS;
  return resolveBlockersFor(row.personId, row.event.termId, now);
}

/**
 * Can this row's recipient actually be reached? Mirrors the reminder engine's
 * guard: an unreachable recipient is skipped WITHOUT claiming, so they are
 * retried rather than silently counted as nudged.
 */
function canReach(row: NudgeRow, channel: string): boolean {
  if (!row.personId) return !!row.attendeeEmail;
  const wantsEmail = channel === "email" || channel === "both";
  const wantsTeams = channel === "teams" || channel === "both";
  if (wantsTeams && !!row.person?.contactEmail) return true;
  return (wantsEmail && !!row.person?.contactEmail) || (wantsTeams && !!row.person?.entraObjectId);
}

/** Render and dispatch one nudge on whichever channel the recipient has. */
async function dispatch(
  row: NudgeRow,
  blockers: AttendanceBlockers,
  triggeredById: string | null,
): Promise<void> {
  const [zone, baseUrl, brandColor] = await Promise.all([
    getDisplayTimeZone(),
    getSetting<string>("app.baseUrl"),
    getSetting<string>("branding.brandColor"),
  ]);

  const name = row.person?.name ?? row.attendeeName ?? "there";
  // A walk-up has no account, so /get-started is a door that does not open for
  // them: point them at the application portal instead.
  const isMember = row.personId !== null;
  const rendered = await renderEmail(
    "attendance-nudge",
    attendanceNudgeContext({
      personName: name,
      eventTitle: row.event.title,
      eventDate: formatDateTime(row.event.startsAt, zone),
      items: blockers.items,
      ctaUrl: `${baseUrl}${isMember ? "/get-started" : "/apply"}`,
      ctaLabel: isMember ? "Finish onboarding" : "Start your application",
      brandColor,
    }),
  );

  if (row.person) {
    await notify(prisma, {
      type: "attendance-nudge",
      person: {
        id: row.person.id,
        entraObjectId: row.person.entraObjectId,
        contactEmail: row.person.contactEmail,
      },
      email: { subject: rendered.subject, html: rendered.html },
      teams: {
        title: "Attendance recorded, onboarding outstanding",
        summary: `Your attendance at ${row.event.title} is recorded, but your onboarding is not finished.`,
        link: `${baseUrl}/get-started`,
      },
      triggeredById: triggeredById ?? undefined,
    });
    return;
  }

  // No Person means no notification inbox and no Teams identity: email is the
  // only channel that exists for a walk-up, so queue it directly.
  await queueEmail(prisma, {
    to: row.attendeeEmail as string,
    subject: rendered.subject,
    html: rendered.html,
    template: "attendance-nudge",
    triggeredById: triggeredById ?? null,
  });
}

/**
 * What one row's nudge attempt did. `resolved` means the row left the stream
 * because nothing is outstanding any more; `skipped` covers every other
 * ordinary non-send (inside the interval, out of attempts, nobody reachable).
 * None of the three is an error.
 */
export type NudgeOutcome = "sent" | "resolved" | "skipped";

async function attemptNudge(
  attendanceId: string,
  triggeredById: string | null,
  now: Date,
): Promise<NudgeOutcome> {
  const row = (await prisma.eventAttendance.findUnique({
    where: { id: attendanceId },
    select: NUDGE_SELECT,
  })) as NudgeRow | null;
  if (!row) return "skipped";

  const blockers = await liveBlockers(row, now);

  // Resolution is checked before the claim so a member who finished everything
  // between check-in and this pass leaves the stream instead of burning an
  // attempt on an email listing nothing.
  if (blockers.keys.length === 0) {
    await prisma.eventAttendance.updateMany({
      where: { id: attendanceId, resolvedAt: null },
      data: { resolvedAt: now },
    });
    return "resolved";
  }

  const channel = await resolveChannel("attendance-nudge");
  if (!canReach(row, channel)) {
    log.info("[attendance] no channel can reach attendee; not nudging", {
      attendanceId,
      personId: row.personId,
    });
    return "skipped";
  }

  const intervalMs = (await getSetting<number>("attendance.nudgeIntervalDays")) * MS_PER_DAY;
  const claim = await prisma.eventAttendance.updateMany({
    where: {
      id: attendanceId,
      resolvedAt: null,
      nudgeCount: { lt: MAX_ATTENDANCE_NUDGES },
      OR: [
        { nudgeLastSentAt: null },
        { nudgeLastSentAt: { lt: new Date(now.getTime() - intervalMs) } },
      ],
    },
    data: { nudgeLastSentAt: now, nudgeCount: { increment: 1 } },
  });
  if (claim.count === 0) return "skipped";

  await dispatch(row, blockers, triggeredById);
  return "sent";
}

/**
 * Send the nudge for one attendance row, if it is still owed one. Returns
 * whether a message was actually queued; see NudgeOutcome for what a false
 * covers.
 */
export async function sendAttendanceNudge(
  attendanceId: string,
  triggeredById: string | null = null,
  now: Date = new Date(),
): Promise<boolean> {
  return (await attemptNudge(attendanceId, triggeredById, now)) === "sent";
}

export type AttendanceNudgeRunResult = {
  sent: number;
  /** Rows whose blockers had cleared, taken out of the stream. */
  resolved: number;
  skipped: number;
  /** Rows whose send threw. The run continues past them. */
  failed: number;
};

/**
 * One pass of the recurring nudge stream.
 *
 * Candidate rows are narrowed in SQL to what could possibly be owed a nudge, so
 * the pass costs one query plus per-row work for the few that qualify -- not a
 * clearance computation for every attendance record ever written.
 */
export async function runAttendanceNudges(
  now: Date = new Date(),
): Promise<AttendanceNudgeRunResult> {
  const result: AttendanceNudgeRunResult = { sent: 0, resolved: 0, skipped: 0, failed: 0 };

  const intervalMs = (await getSetting<number>("attendance.nudgeIntervalDays")) * MS_PER_DAY;
  const rows = (await prisma.eventAttendance.findMany({
    where: {
      resolvedAt: null,
      nudgeCount: { lt: MAX_ATTENDANCE_NUDGES },
      event: {
        startsAt: { gte: new Date(now.getTime() - NUDGE_LOOKBACK_DAYS * MS_PER_DAY) },
      },
      OR: [
        { nudgeLastSentAt: null },
        { nudgeLastSentAt: { lt: new Date(now.getTime() - intervalMs) } },
      ],
    },
    orderBy: { checkedInAt: "asc" },
    select: NUDGE_SELECT,
  })) as NudgeRow[];

  for (const row of rows) {
    // Per-row isolation, matching every sibling reminder job: one unrenderable
    // row must not cost everyone behind it their follow-up.
    try {
      const outcome = await attemptNudge(row.id, null, now);
      if (outcome === "sent") result.sent++;
      else if (outcome === "resolved") result.resolved++;
      else result.skipped++;
    } catch (err) {
      result.failed++;
      log.error("[attendance] nudge pass failed for row", {
        attendanceId: row.id,
        ...errorAttrs(err),
      });
    }
  }

  return result;
}
