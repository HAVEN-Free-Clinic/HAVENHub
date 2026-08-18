/**
 * Weekly attending reminder. Sent Monday mornings to the attendings covering the
 * upcoming clinic day, with the slot-by-slot schedule and the on-call line.
 *
 * Queues email directly against the ROSTER address rather than going through
 * notify(), and deliberately keeps doing so now that attendings can have Hub
 * accounts (Attending.personId). Three reasons it stays this way:
 *
 *   - Hub access is opt-in per attending and several have no email at all, so
 *     notify() would have to fall back to this path for part of the roster
 *     anyway. One path is better than two that must agree.
 *   - The roster address is the one Faculty Relations maintains and the one the
 *     letter has always gone to; Person.contactEmail is a copy of it made when
 *     access was enabled, and can drift.
 *   - This is Faculty Relations' weekly letter to the whole covering group, not
 *     a per-person notification with a channel preference to honour.
 *
 * Attendings WITH a Hub account still see the same schedule at /schedule, which
 * is where the email points them.
 *
 * Enqueue-only, like every other reminder here: the per-minute
 * /api/cron/email drainer delivers. Draining here would double-send.
 */

import { prisma } from "@/platform/db";
import { esc } from "@/platform/email/render/escape";
import { getActiveTerm } from "@/platform/terms/active-term";
import { getSetting } from "@/platform/settings/service";
import { formatCalendarDate, isoDateKey } from "@/platform/dates";
import { selectCurrentClinicDate } from "@/platform/teams/channel-link";
import { renderEmail } from "./templates/renderEmail";
import { queueEmail } from "./send";
import { attendingReminderContext } from "./templates/attending";
import { log, errorAttrs } from "@/platform/logging";

export type AttendingReminderRunResult = {
  remindersSent: number;
  /** On the roster and covering the day, but with no email address on file. */
  skippedNoEmail: number;
  /** Already reminded for this clinic date. */
  skippedAlreadySent: number;
};

/** Coverage of one clinic date, grouped by slot, as the email renders it. */
export type ReminderCoverage = Array<{
  slotLabel: string;
  attendings: Array<{ id: string; scheduleName: string; email: string | null }>;
}>;

/**
 * The schedule block of the email.
 *
 * Mirrors how Faculty Relations already writes it by hand -- one bold slot label
 * per line, names after it -- so the Hub's version reads like the letter the
 * attendings already receive rather than a table they have to re-learn.
 *
 * Every name is escaped here, which is why the template renders this raw.
 */
export function renderScheduleTable(coverage: ReminderCoverage): string {
  const lines = coverage
    .filter((slot) => slot.attendings.length > 0)
    .map(
      (slot) =>
        `<strong>${esc(slot.slotLabel)}</strong>: ` +
        slot.attendings.map((a) => esc(a.scheduleName)).join(", "),
    );
  return lines.length > 0 ? `<p>${lines.join("<br/>")}</p>` : "";
}

/**
 * Weekly attending reminders for the upcoming clinic day.
 *
 * Sends ONE email per attending covering the day. The body is the same for all
 * of them: the schedule is a shared fact, and the original letter was addressed
 * to everyone at once.
 */
export async function runAttendingReminders(
  now: Date = new Date(),
): Promise<AttendingReminderRunResult> {
  const result: AttendingReminderRunResult = {
    remindersSent: 0,
    skippedNoEmail: 0,
    skippedAlreadySent: 0,
  };

  const term = await getActiveTerm();
  if (!term) return result;

  const targetDate = selectCurrentClinicDate(term.clinicDates, now);
  if (!targetDate) return result;

  // Only remind for THIS week's clinic. Without the bound, a break week would
  // point at a future Saturday and re-send every Monday until it arrived.
  // Compare by UTC calendar day; clinic dates are anchored at noon UTC.
  const MS_PER_DAY = 24 * 60 * 60 * 1000;
  const nowDay = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const targetDay = Date.UTC(
    targetDate.getUTCFullYear(),
    targetDate.getUTCMonth(),
    targetDate.getUTCDate(),
  );
  if (Math.round((targetDay - nowDay) / MS_PER_DAY) > 6) return result;

  const targetKey = isoDateKey(targetDate);

  const day = await prisma.clinicDay.findUnique({
    where: { termId_clinicDate: { termId: term.id, clinicDate: targetDate } },
    select: {
      isClosed: true,
      onCallAttending: { select: { scheduleName: true, isActive: true } },
      attendings: {
        orderBy: [{ slot: { order: "asc" } }, { order: "asc" }],
        select: {
          slot: { select: { label: true } },
          attending: { select: { id: true, scheduleName: true, email: true, isActive: true } },
        },
      },
    },
  });

  // Nothing scheduled, or the clinic is closed: there is no shift to remind
  // anyone about, and a "reminder" for a closed Saturday would be wrong.
  if (!day || day.isClosed) return result;

  const coverage: ReminderCoverage = [];
  for (const row of day.attendings) {
    // A deactivated attending is not covering; emailing them would be worse than
    // the gap, since they may have left the clinic entirely.
    if (!row.attending.isActive) continue;
    const existing = coverage.find((c) => c.slotLabel === row.slot.label);
    const entry = { id: row.attending.id, scheduleName: row.attending.scheduleName, email: row.attending.email };
    if (existing) existing.attendings.push(entry);
    else coverage.push({ slotLabel: row.slot.label, attendings: [entry] });
  }
  if (coverage.length === 0) return result;

  const context = attendingReminderContext({
    clinicDateLabel: formatCalendarDate(targetDate, {
      weekday: "long",
      month: "long",
      day: "numeric",
      year: "numeric",
    }),
    scheduleTable: renderScheduleTable(coverage),
    onCallAttending: day.onCallAttending?.isActive ? day.onCallAttending.scheduleName : "",
    signOffName: await getSetting<string>("branding.orgName"),
    clinicAddress: await getSetting<string>("schedule.clinicAddress"),
    contactEmail: await getSetting<string>("branding.supportEmail"),
  });

  const rendered = await renderEmail("attending-reminder", context);

  // One row per attending covering the day, deduped: someone in two slots gets
  // one email, not two.
  const recipients = new Map<string, { scheduleName: string; email: string | null }>();
  for (const slot of coverage) {
    for (const a of slot.attendings) recipients.set(a.id, a);
  }

  // Idempotency: skip anyone already sent this reminder within 6 days, which
  // scopes to the current clinic week so a re-fired Monday cron cannot
  // double-send. Matched on the recipient ADDRESS because an attending has no
  // Person row for EmailLog.personId to carry.
  const cutoff = new Date(now.getTime() - 6 * MS_PER_DAY);

  for (const [attendingId, attending] of recipients) {
    if (!attending.email) {
      result.skippedNoEmail++;
      continue;
    }

    const already = await prisma.emailLog.findFirst({
      where: { toEmail: attending.email, template: "attending-reminder", createdAt: { gte: cutoff } },
      select: { id: true },
    });
    if (already) {
      result.skippedAlreadySent++;
      continue;
    }

    try {
      await queueEmail(prisma, {
        to: attending.email,
        subject: rendered.subject,
        html: rendered.html,
        template: "attending-reminder",
      });
      result.remindersSent++;
    } catch (err) {
      // Per-recipient isolation: one bad address must not abort the batch.
      log.error(
        `[attending-reminders] Failed to remind attending ${attendingId}`,
        errorAttrs(err, { attendingId, targetKey }),
      );
    }
  }

  return result;
}
