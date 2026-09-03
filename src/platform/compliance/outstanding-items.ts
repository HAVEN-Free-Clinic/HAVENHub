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
