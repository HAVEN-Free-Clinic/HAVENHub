import { prisma, isUniqueConstraintError } from "@/platform/db";

/**
 * Atomically claim a single reminder dispatch for (kind, personId, periodKey).
 *
 * Returns true if THIS caller won the claim (and should send), false if the marker
 * already existed (a prior or a concurrently-running cron already claimed it). The
 * unique index on (kind, personId, periodKey) makes the insert the claim, so two
 * overlapping cron invocations cannot both send the same periodic reminder.
 *
 * Used by the shift-reminder and schedule-request-reminder crons, which have no
 * per-person state table of their own (compliance reminders claim via their own
 * ComplianceReminder row instead).
 */
export async function claimReminderDispatch(
  kind: string,
  personId: string,
  periodKey: string,
): Promise<boolean> {
  try {
    await prisma.reminderDispatch.create({ data: { kind, personId, periodKey } });
    return true;
  } catch (err) {
    if (isUniqueConstraintError(err)) return false;
    throw err;
  }
}
