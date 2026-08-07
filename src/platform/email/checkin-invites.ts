import { prisma } from "@/platform/db";
import { getActiveTerm } from "@/platform/terms/active-term";
import { getSetting } from "@/platform/settings/service";
import { formatCalendarDate, isoDateKey } from "@/platform/dates";
import { displayTodayKey } from "@/platform/dates/today";
import { notify } from "@/platform/notifications/notify";
import { renderEmail } from "./templates/renderEmail";
import { claimReminderDispatch, releaseReminderDispatch } from "./reminder-dispatch";
import { log, errorAttrs } from "@/platform/logging";

const TEMPLATE_KEY = "clinic-checkin-invite";

// Distinct from "shift-reminder" so a claim taken here can never collide with
// (or be starved by) the weekly shift-reminder cron's own claims on the same
// (personId, periodKey) shape.
const DISPATCH_KIND = "clinic-checkin-invite";

function firstNameOf(name: string): string {
  const parts = name.trim().split(/\s+/);
  return parts[0] || name;
}

export type CheckInInviteRunResult = { skipped: boolean; queued: number };

/**
 * Morning-of check-in invitations.
 *
 * Runs DAILY and no-ops unless today is a clinic date for the live term, rather
 * than assuming Saturday: a rescheduled or midweek clinic still gets its email.
 *
 * ENQUEUES ONLY. Delivery is /api/cron/email's job; draining here would run
 * concurrently with that route and double-send.
 *
 * Idempotent per (person, clinic day) via claimReminderDispatch: the external
 * scheduler (cron-job.org) retries on a timeout or a 5xx, and this route's
 * loop can take a while on a large roster, so a second firing on the same
 * clinic morning must not re-queue a check-in email to everyone already
 * invited.
 */
export async function runCheckInInvites(now: Date = new Date()): Promise<CheckInInviteRunResult> {
  const term = await getActiveTerm();
  if (!term) return { skipped: true, queued: 0 };

  const todayKey = await displayTodayKey(now);
  const clinicDate = term.clinicDates.find((d) => isoDateKey(d) === todayKey);
  if (!clinicDate) return { skipped: true, queued: 0 };

  const assignments = await prisma.shiftAssignment.findMany({
    where: { termId: term.id, clinicDate },
    select: {
      person: {
        select: { id: true, name: true, contactEmail: true, entraObjectId: true, status: true },
      },
    },
  });

  // One email per PERSON, not per assignment: someone on two departments'
  // schedules that day arrives once and should be asked once.
  const byPerson = new Map<string, (typeof assignments)[number]["person"]>();
  for (const a of assignments) {
    if (a.person.status !== "ACTIVE") continue;
    byPerson.set(a.person.id, a.person);
  }

  const baseUrl = await getSetting<string>("app.baseUrl");
  const clinicDateLabel = formatCalendarDate(clinicDate, {
    weekday: "long",
    month: "long",
    day: "numeric",
  });
  const checkInUrl = `${baseUrl}/schedule/check-in`;
  const clinicDateKey = isoDateKey(clinicDate);

  let queued = 0;
  for (const person of byPerson.values()) {
    // Atomic per-clinic-day claim: even if two invocations overlap (a
    // cron-job.org retry on top of the run it retried), only one wins this
    // insert, so no volunteer is double-invited for the same clinic morning.
    const claimed = await claimReminderDispatch(DISPATCH_KIND, person.id, clinicDateKey);
    if (!claimed) continue;

    try {
      const rendered = await renderEmail(TEMPLATE_KEY, {
        firstName: firstNameOf(person.name),
        clinicDateLabel,
        checkInUrl,
      });

      await notify(prisma, {
        type: TEMPLATE_KEY,
        person,
        email: { subject: rendered.subject, html: rendered.html },
        teams: {
          title: "Clinic check-in",
          summary: `You are scheduled for clinic today, ${clinicDateLabel}. Check in when you arrive.`,
          link: checkInUrl,
        },
      });
      queued += 1;
    } catch (err) {
      // Release the claim (taken before the enqueue) so a later tick can
      // retry this person instead of the claim silently suppressing them,
      // then log and continue: one bad recipient must not abort the batch.
      await releaseReminderDispatch(DISPATCH_KIND, person.id, clinicDateKey);
      log.error(
        `[checkin-invites] Failed to queue check-in invite for person ${person.id}`,
        errorAttrs(err, { personId: person.id }),
      );
    }
  }

  return { skipped: false, queued };
}
