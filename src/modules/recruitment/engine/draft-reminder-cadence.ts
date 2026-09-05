const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export const ROUTINE_REMINDER_LIMIT = 3;
export const FINAL_REMINDER_LIMIT = 3;

/**
 * Deadline checkpoints for the final stream. Index N is the deadline distance
 * at which final reminder N becomes due. A late/deployed-mid-cycle stream catches
 * up one checkpoint per daily run instead of sending several messages at once.
 */
const FINAL_THRESHOLDS_MS = [7 * DAY_MS, 3 * DAY_MS, DAY_MS] as const;

export type DraftReminderKind = "routine" | "final";

export type DraftReminderState = {
  status: string;
  cycleStatus: string;
  opensAt: Date | null;
  closesAt: Date | null;
  updatedAt: Date;
  lastSentAt: Date | null;
  routineCount: number;
  finalCount: number;
};

/**
 * Decide whether a draft is due, without touching the database.
 *
 * Routine reminders begin after 48 quiet hours and recur weekly. During the
 * final seven days the routine stream pauses and the independent 7/3/1-day
 * deadline stream takes over. Every message requires at least 20 quiet hours,
 * so an applicant who just saved progress (or was just reminded) is not emailed
 * again by the next morning's cron.
 */
export function dueDraftReminder(state: DraftReminderState, now: Date): DraftReminderKind | null {
  if (state.status !== "DRAFT" || state.cycleStatus !== "OPEN") return null;
  if (state.opensAt && state.opensAt > now) return null;
  if (state.closesAt && state.closesAt < now) return null;

  const lastActivity = Math.max(state.updatedAt.getTime(), state.lastSentAt?.getTime() ?? 0);
  const quietFor = now.getTime() - lastActivity;
  if (quietFor < 20 * HOUR_MS) return null;

  if (state.closesAt) {
    const untilClose = state.closesAt.getTime() - now.getTime();
    if (untilClose <= FINAL_THRESHOLDS_MS[0]) {
      if (state.finalCount >= FINAL_REMINDER_LIMIT) return null;
      return untilClose <= FINAL_THRESHOLDS_MS[state.finalCount] ? "final" : null;
    }
  }

  if (state.routineCount >= ROUTINE_REMINDER_LIMIT) return null;
  const wait = state.routineCount === 0 ? 2 * DAY_MS : 7 * DAY_MS;
  return quietFor >= wait ? "routine" : null;
}
