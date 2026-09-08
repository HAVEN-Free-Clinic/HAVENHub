/**
 * Human-readable sentences for the things a member still has to do.
 *
 * Lifted out of platform/email/reminders.ts, which owned them privately, once a
 * second sender needed the same list: the event check-in nudge (see
 * platform/email/attendance-nudges.ts) tells someone who was checked in at
 * training or an info session what is still outstanding. Two hand-maintained
 * copies of this wording would drift, and they are read side by side -- the same
 * member can get the onboarding reminder and the check-in nudge in one week.
 *
 * The keys are onboarding task keys (see modules/onboarding/engine/status.ts)
 * plus one synthetic key, `contract`, which no clearance task produces: it means
 * "this person has no ACTIVE TermMembership for the term", i.e. they never
 * submitted the onboarding contract that promotion turns into a roster row.
 * Clearance cannot express that, because clearance is computed FOR members.
 */

// Through the platform facade, not the onboarding module directly: platform code
// must not import module code (see platform/clearance.ts).
import type { OnboardingTaskKey } from "@/platform/clearance";

/**
 * Everything that can be outstanding, including the synthetic `contract` key
 * that only the attendance nudge raises.
 */
export type OutstandingItemKey = OnboardingTaskKey | "contract";

/**
 * Sentences phrased as instructions to the member, each self-serviceable.
 *
 * `contract` leads with the consequence rather than the task because it is the
 * only item whose absence makes every other item invisible: with no membership
 * there is no roster row, so nothing else can even be checked.
 */
export const OUTSTANDING_ITEM_LABELS: Record<OutstandingItemKey, string> = {
  contract: "Submit your onboarding contract, which is what adds you to the roster",
  profile: "Confirm your contact details in your profile",
  hipaa: "Complete and upload your HIPAA certificate",
  ehs: "Complete your required EHS training",
  training: "Finish this term's volunteer training",
  directorTraining: "Finish this term's director training",
  learning: "Complete your assigned learning courses",
};

/**
 * The same items as two or three words, for a surface with no room for a
 * sentence.
 *
 * The door screen renders these as chips beside an attendee's name while a queue
 * waits behind them: the operator needs to know at a glance what to say out
 * loud, and "Complete and upload your HIPAA certificate" is a sentence written
 * for the member reading their own email, not for someone scanning a screen.
 *
 * Kept in this file rather than beside the component precisely because the two
 * are read minutes apart -- the operator says one, the attendee receives the
 * other -- and a chip reading "Health forms" against an email reading "HIPAA
 * certificate" is the drift this module exists to prevent. Same keys, one place
 * to add a task.
 */
export const OUTSTANDING_ITEM_SHORT: Record<OutstandingItemKey, string> = {
  contract: "Onboarding contract",
  profile: "Profile details",
  hipaa: "HIPAA certificate",
  ehs: "EHS training",
  training: "Volunteer training",
  directorTraining: "Director training",
  learning: "Learning courses",
};

/**
 * Short labels for outstanding keys, dropping any this module has no name for.
 *
 * Mirrors outstandingItems' handling of an unknown key, for the same reason: a
 * task key added to the onboarding engine without a label here must not reach a
 * door screen as the raw string "directorTraining".
 */
export function outstandingShortLabels(keys: readonly string[]): string[] {
  const out: string[] = [];
  for (const key of keys) {
    const label = OUTSTANDING_ITEM_SHORT[key as OutstandingItemKey];
    if (label) out.push(label);
  }
  return out;
}

/**
 * Turn outstanding keys into display sentences.
 *
 * @param keys       Outstanding keys, in the order they should read.
 * @param ehsMissing Specific outstanding EHS course names, appended to the EHS
 *                   row when there are any. This is the detail the bundled
 *                   compliance email used to carry.
 * @param skip       Keys to drop. The reminder engine passes `["hipaa"]`,
 *                   because HIPAA has its own stream there and naming it twice
 *                   in one day is what that split exists to avoid. The
 *                   attendance nudge passes nothing: it is a single one-shot
 *                   message that has to be complete on its own.
 */
export function outstandingItems(
  keys: readonly string[],
  opts: { ehsMissing?: string[]; skip?: readonly OutstandingItemKey[] } = {},
): string[] {
  const skip = new Set<string>(opts.skip ?? []);
  const ehsMissing = opts.ehsMissing ?? [];
  const out: string[] = [];
  for (const key of keys) {
    if (skip.has(key)) continue;
    const label = OUTSTANDING_ITEM_LABELS[key as OutstandingItemKey];
    // Unknown keys are dropped rather than rendered raw: a task key added to the
    // onboarding engine without a sentence here would otherwise reach a member
    // as "directorTraining".
    if (!label) continue;
    out.push(key === "ehs" && ehsMissing.length > 0 ? `${label}: ${ehsMissing.join(", ")}` : label);
  }
  return out;
}
