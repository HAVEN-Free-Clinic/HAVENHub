/**
 * How often approvers are re-reminded about a pending swap/drop request.
 *
 * The reminder cron was originally date-blind: every pending request waited 48
 * hours to earn its first reminder, and each approver was then throttled for 3
 * days. That is fine for a request filed weeks out, and useless for the case it
 * most needs to cover -- someone dropping a shift two days before clinic. By the
 * time the first reminder was due, the clinic had happened; and if the approver
 * had already received the original submission notice, the 3-day throttle
 * silenced the reminder entirely.
 *
 * So the cadence keys on how soon the affected shift actually is. A request for
 * a clinic inside URGENT_WINDOW_DAYS becomes remindable within hours and is
 * re-sent daily; everything else keeps the original, quieter cadence.
 *
 * Pure and total: no clock, no I/O. The caller supplies day keys and an age.
 */

export type ReminderUrgency = "URGENT" | "NORMAL";

/**
 * A clinic date this many days out (or nearer) makes its pending request
 * urgent. Seven days covers the weekly Saturday clinic rhythm: any request
 * still pending for the NEXT clinic is urgent, because there is no later
 * approval slot for it.
 */
export const URGENT_WINDOW_DAYS = 7;

export type Cadence = {
  /** How old a request must be before it earns a reminder at all. */
  minAgeMs: number;
  /** How long an approver is silenced after any reminder for this template. */
  throttleMs: number;
};

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export const CADENCE: Record<ReminderUrgency, Cadence> = {
  // Same day the request is filed, then daily. A director who lets this sit is
  // the last thing standing between a volunteer and an unresolved shift.
  URGENT: { minAgeMs: 12 * HOUR_MS, throttleMs: 1 * DAY_MS },
  // The original cadence, unchanged, for requests with room to breathe.
  NORMAL: { minAgeMs: 48 * HOUR_MS, throttleMs: 3 * DAY_MS },
};

/** Whole days from `fromKey` to `toKey`, negative when `toKey` is earlier. */
function daysBetween(fromKey: string, toKey: string): number {
  const from = Date.parse(`${fromKey}T00:00:00Z`);
  const to = Date.parse(`${toKey}T00:00:00Z`);
  if (Number.isNaN(from) || Number.isNaN(to)) return Number.POSITIVE_INFINITY;
  return Math.round((to - from) / DAY_MS);
}

/**
 * How pressing a pending request is, from the clinic date it affects.
 *
 * A date already in the PAST is deliberately NOT urgent: the shift has happened
 * and no approval can change it, so escalating would nag daily about something
 * nobody can fix. It still gets the normal cadence, because the request does
 * need dispositioning for the record.
 *
 * An unparseable date key degrades to NORMAL rather than throwing, keeping this
 * safe to call from the cron path.
 */
export function reminderUrgency(input: {
  /** Day key of the shift being dropped or swapped away. */
  requesterDateKey: string;
  /** Display-zone day key for "now". */
  todayKey: string;
}): ReminderUrgency {
  const daysOut = daysBetween(input.todayKey, input.requesterDateKey);
  if (daysOut < 0) return "NORMAL";
  return daysOut <= URGENT_WINDOW_DAYS ? "URGENT" : "NORMAL";
}

/** The cadence for a given urgency. */
export function cadenceFor(urgency: ReminderUrgency): Cadence {
  return CADENCE[urgency];
}

/** Has a request aged into its first reminder? */
export function isRemindable(input: { urgency: ReminderUrgency; ageMs: number }): boolean {
  return input.ageMs >= CADENCE[input.urgency].minAgeMs;
}

/**
 * Order pending requests so the most pressing is handled first.
 *
 * This matters because the cron takes at most ONE per-day dispatch claim per
 * approver: whichever request reaches them first is the one they hear about
 * today. Urgent before normal, then soonest clinic date first.
 */
export function byUrgencyThenDate<T extends { urgency: ReminderUrgency; requesterDateKey: string }>(
  a: T,
  b: T,
): number {
  if (a.urgency !== b.urgency) return a.urgency === "URGENT" ? -1 : 1;
  return a.requesterDateKey < b.requesterDateKey ? -1 : a.requesterDateKey > b.requesterDateKey ? 1 : 0;
}
