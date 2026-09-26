import { getMyEhsStatus } from "@/platform/ehs/services/my-ehs";
import { getAccessTerm } from "@/platform/terms/access-term";

/**
 * Said whenever an EHS item is outstanding, because the most common EHS
 * question is not "what do I owe" but "I finished it, why does the Hub still
 * say I didn't". EHS completions are never synced from Yale's system: a
 * coordinator records each one by hand (markEhsComplete, source MANUAL), so a
 * finished training reads as outstanding until that happens. Three of the
 * tickets escalated out of Intercom in August and September 2026 were exactly
 * this, and each came after Fin could only say the training was missing.
 */
export const EHS_RECORDING_NOTE =
  "EHS trainings are completed in Yale's EHS system and then recorded in the Hub by a coordinator, so one you already finished shows as outstanding until it is recorded. If you already finished it, ask to talk to a person on the team and have your Yale EHS completion record ready.";

/**
 * The member's outstanding EHS trainings as one clause, or null when none are.
 *
 * Computed for the access term (the live term, or the next one for a member
 * onboarding ahead of the switch), the same term getOnboardingStatus judges
 * clearance against and the same one /volunteers/compliance/[personId] passes,
 * so this list cannot name a training the clearance answer does not count.
 *
 * Each item carries its Yale completion link when the catalog has one. A null
 * link means the training is not self-serve (TB screening, for one), and the
 * item is named without a link rather than with a dead one.
 */
export async function outstandingEhsClause(personId: string): Promise<string | null> {
  const term = await getAccessTerm(personId);
  const items = await getMyEhsStatus(personId, term?.id);
  const missing = items.filter((i) => !i.complete);
  if (missing.length === 0) return null;

  const names = missing.map((i) => (i.completionUrl ? `${i.name} (complete it at ${i.completionUrl})` : i.name));
  return `EHS training not yet recorded: ${names.join(", ")}. ${EHS_RECORDING_NOTE}`;
}
