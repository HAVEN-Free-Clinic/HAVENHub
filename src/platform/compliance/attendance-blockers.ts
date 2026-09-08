/**
 * "Why this person's attendance will not be credited yet."
 *
 * Someone can be physically at training before the hub knows anything about
 * them: the onboarding contract is what promotion turns into an ACTIVE
 * TermMembership (see services/promotion.ts), and until that row exists they are
 * on no roster, no clearance surface, and no compliance report. Recording their
 * attendance anyway is the point of event check-in -- but the record is worth
 * little if nobody tells them their attendance cannot count until the rest is
 * done, which is exactly the email this module feeds.
 *
 * Two sources, unioned:
 *   - the synthetic `contract` blocker, raised when the attendee has no ACTIVE
 *     membership in the event's term. Clearance cannot express this: it is
 *     computed FOR members.
 *   - `ClearanceSummary.missing` from the shared clearance engine, so the list
 *     agrees exactly with the member's own /get-started checklist rather than
 *     re-deriving the same facts a second way.
 *
 * A non-member's clearance is deliberately thin: loadClearanceMap drops the
 * training, learning and EHS tasks for someone with no membership (they are
 * derived from department and track), so a walk-up gets `contract` plus HIPAA
 * and profile. That is the honest answer -- their EHS and learning requirements
 * are not knowable until they have a department -- and it is why `contract`
 * leads the list.
 */

import { prisma } from "@/platform/db";
import { loadClearanceMap } from "@/platform/clearance";
import { loadEhsMissingMap } from "@/platform/ehs/services/status";
import {
  outstandingItems,
  type OutstandingItemKey,
} from "@/platform/compliance/outstanding-items";

export type AttendanceBlockers = {
  /** Outstanding keys, `contract` first when present. Empty means fully cleared. */
  keys: OutstandingItemKey[];
  /** The same list as member-facing sentences, ready for an email. */
  items: string[];
};

export const NO_BLOCKERS: AttendanceBlockers = { keys: [], items: [] };

/**
 * What an unlinked STRANGER is told, in place of a clearance list nobody can
 * compute for them. Phrased for someone who may not have applied at all, which
 * is why it does not reuse the shared `contract` sentence (that one speaks to an
 * accepted applicant who owes a contract -- see ACCEPTED_APPLICANT_BLOCKERS,
 * which is what an unlinked row on the cycle's accepted list gets instead).
 * Reach both through resolveWalkUpBlockers rather than picking one at a call
 * site, so the check-in path and the recurring nudge cannot drift apart.
 */
export const WALK_UP_BLOCKERS: AttendanceBlockers = {
  keys: ["contract"],
  items: ["Submit an application and onboarding contract so your attendance can be credited"],
};

/**
 * What an accepted applicant is told, in place of the stranger's message above.
 *
 * Both rows look identical in the database -- unlinked, keyed on a lowercased
 * email, no Person to compute clearance for -- but the people are not the same
 * person, and the difference is the whole reason the door lets an accepted
 * applicant be checked in at all. Someone who applied, interviewed, and was
 * accepted has one thing left, and telling them to "submit an application" is
 * both wrong and the kind of wrong that makes them mail a director to ask
 * whether their acceptance was rescinded.
 *
 * The sentence is the shared `contract` one, so this reads exactly like the
 * message a promoted member's own clearance would produce.
 */
export const ACCEPTED_APPLICANT_BLOCKERS: AttendanceBlockers = {
  keys: ["contract"],
  items: outstandingItems(["contract"]),
};

/**
 * Which of the two unlinked-row messages this email should get.
 *
 * Called for a row with no Person, where no clearance exists to compute: the
 * only question left is whether the hub already knows this address was accepted
 * into the cycle the event belongs to.
 *
 * Deliberately re-asked rather than snapshotted. The check-in path and the
 * recurring nudge both route through here, so an applicant accepted the week
 * AFTER they walked into an info session stops being told to apply on their very
 * next follow-up, and one whose acceptance was rescinded stops being told they
 * are nearly done.
 *
 * @param email    The row's `attendeeEmail`, already lowercased by the writer.
 * @param cycleId  The event's cycle, or null for an event that belongs to none
 *                 (a standing training with no recruitment cycle behind it).
 *                 With no cycle there is no accepted list to be on, so the
 *                 stranger's message is the only honest answer.
 */
export async function resolveWalkUpBlockers(
  email: string | null,
  cycleId: string | null,
): Promise<AttendanceBlockers> {
  return (await isAcceptedApplicantEmail(email, cycleId))
    ? ACCEPTED_APPLICANT_BLOCKERS
    : WALK_UP_BLOCKERS;
}

/**
 * Was this address accepted into this cycle?
 *
 * Split out of resolveWalkUpBlockers because the door asks the same question for
 * a different reason: an address nobody accepted is one the operator should be
 * asked about before a row is written for it. One definition of "on the accepted
 * list", so the message an attendee receives and the question the door asks
 * cannot disagree about who is on it.
 *
 * `Applicant.emailLower` is maintained as lower(email) by the submission service
 * and backs a unique index, so this is an index hit rather than a scan with a
 * case-insensitive comparison.
 */
export async function isAcceptedApplicantEmail(
  email: string | null,
  cycleId: string | null,
): Promise<boolean> {
  if (!email || !cycleId) return false;
  const accepted = await prisma.acceptance.findFirst({
    where: { application: { cycleId, applicant: { emailLower: email.trim().toLowerCase() } } },
    select: { id: true },
  });
  return accepted !== null;
}

/**
 * Resolve blockers for many people in one term, in one pass.
 *
 * Every input id is present in the result (with empty lists when nothing is
 * outstanding), so callers never have to distinguish "cleared" from "not
 * looked up".
 *
 * @param now Reference time for HIPAA expiry, threaded through to the clearance
 *            engine so a caller evaluating "as of" a moment stays consistent.
 */
export async function resolveAttendanceBlockers(
  personIds: string[],
  termId: string,
  now?: Date,
): Promise<Map<string, AttendanceBlockers>> {
  const out = new Map<string, AttendanceBlockers>();
  if (personIds.length === 0) return out;

  const unique = Array.from(new Set(personIds));

  const [memberships, clearance] = await Promise.all([
    prisma.termMembership.findMany({
      where: { personId: { in: unique }, termId, status: "ACTIVE" },
      select: { personId: true },
    }),
    loadClearanceMap(unique, termId, now),
  ]);

  const members = new Set(memberships.map((m) => m.personId));

  const keysByPerson = new Map<string, OutstandingItemKey[]>();
  let anyEhs = false;
  for (const personId of unique) {
    const keys: OutstandingItemKey[] = [];
    if (!members.has(personId)) keys.push("contract");
    for (const key of clearance.get(personId)?.missing ?? []) {
      keys.push(key);
      if (key === "ehs") anyEhs = true;
    }
    keysByPerson.set(personId, keys);
  }

  // The specific outstanding EHS course names cost a whole-term query (every
  // ACTIVE membership plus the catalog and completions), and they only ever
  // decorate the `ehs` row. Skipping it when nobody in this batch is missing EHS
  // keeps the common case -- a check-in at a door, one person, blocked on their
  // contract or HIPAA -- off that query entirely. Keyed by the term's ACTIVE
  // members only, so a non-member has no entry either way: correct, because
  // their EHS requirement is not yet knowable.
  const ehsMissing = anyEhs ? await loadEhsMissingMap(termId) : null;

  for (const [personId, keys] of keysByPerson) {
    out.set(personId, {
      keys,
      items: outstandingItems(keys, { ehsMissing: ehsMissing?.get(personId) ?? [] }),
    });
  }

  return out;
}

/** Single-person convenience wrapper over resolveAttendanceBlockers. */
export async function resolveBlockersFor(
  personId: string,
  termId: string,
  now?: Date,
): Promise<AttendanceBlockers> {
  const map = await resolveAttendanceBlockers([personId], termId, now);
  return map.get(personId) ?? NO_BLOCKERS;
}
