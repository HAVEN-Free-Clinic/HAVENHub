import { isoDateKey, formatForDateInput } from "@/platform/dates";

/**
 * Whether the self-serve makeup quiz is available. The makeup is for members who
 * missed the in-person session, so it opens the day AFTER inPersonTrainingDate:
 * true when no date is set (no gate), or when "today" in the display zone is
 * strictly past the training day. All comparison is by calendar day key in
 * `zone`, never raw timestamps, so there is no UTC-midnight rollover.
 */
export function makeupIsOpen(inPersonTrainingDate: Date | null, now: Date, zone: string): boolean {
  if (!inPersonTrainingDate) return true;
  const trainingKey = isoDateKey(inPersonTrainingDate); // noon-UTC anchored -> its calendar day
  const todayKey = formatForDateInput(now, zone); // zone-local YYYY-MM-DD
  return todayKey > trainingKey;
}

/** The calendar day the makeup opens (the day after the training date), noon-UTC anchored. */
export function makeupOpensOn(inPersonTrainingDate: Date): Date {
  return new Date(inPersonTrainingDate.getTime() + 86_400_000);
}
