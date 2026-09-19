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
 * which is what an unlinked row on the cycle's accepted list gets instead, and
 * WAITLISTED_APPLICANT_BLOCKERS for the third case).
 * Reach all three through resolveWalkUpBlockers rather than picking one at a
 * call site, so the check-in path and the recurring nudge cannot drift apart.
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
 * What a WAITLISTED applicant is told: nothing.
 *
 * Empty, and deliberately not the `contract` sentence the two shapes above
 * share. A waitlisted applicant has no Acceptance, and the onboarding contract
 * is minted from one -- so every sentence about finishing onboarding names a
 * form they cannot open, and "submit an application" is wrong for someone who
 * applied and was interviewed. The honest list of what they can do next is
 * empty, and an empty list is also what keeps them out of the nudge stream
 * (attendance-nudges resolves a row the moment nothing is outstanding), which is
 * the point: the clinic owes them a decision, not a reminder.
 *
 * Their attendance is still recorded, and still counts. If they are later
 * promoted off the waitlist and onboard, linkAttendanceByEmail attaches this row
 * to the Person promotion creates and credits the training they sat through.
 */
export const WAITLISTED_APPLICANT_BLOCKERS: AttendanceBlockers = { keys: [], items: [] };

/**
 * Where an unlinked attendee stands with the event's cycle.
 *
 * Three states rather than the boolean this started as, because the door and the
 * nudge both have three things to say and only ever had words for two: someone
 * the cycle accepted owes a contract, someone it waitlisted owes nothing yet,
 * and someone it has never heard of owes an application. Collapsing the middle
 * one into either neighbour produces a message that is wrong in a way the
 * recipient will mail a director about.
 */
export type ApplicantStanding = "accepted" | "waitlisted" | "unknown";

/** The message each standing gets. One mapping, so the door's chips, the check-in
 *  snapshot and the follow-up email cannot disagree about one person. */
export function blockersForStanding(standing: ApplicantStanding): AttendanceBlockers {
  if (standing === "accepted") return ACCEPTED_APPLICANT_BLOCKERS;
  if (standing === "waitlisted") return WAITLISTED_APPLICANT_BLOCKERS;
  return WALK_UP_BLOCKERS;
}

/**
 * Which of the three unlinked-row messages this email should get.
 *
 * Called for a row with no Person, where no clearance exists to compute: the
 * only question left is what the hub already knows about this address in the
 * cycle the event belongs to.
 *
 * Deliberately re-asked rather than snapshotted. The check-in path and the
 * recurring nudge both route through here, so an applicant accepted the week
 * AFTER they walked into an info session stops being told to apply on their very
 * next follow-up, one whose acceptance was rescinded stops being told they are
 * nearly done, and one promoted off the waitlist starts being asked for the
 * contract that promotion just made available to them.
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
  return blockersForStanding(await resolveApplicantStanding(email, cycleId));
}

/**
 * How this address stands in this cycle.
 *
 * Split out of resolveWalkUpBlockers because the door asks the same question for
 * a different reason: an address the cycle has never heard of is one the operator
 * should be asked about before a row is written for it, and one it waitlisted is
 * not. One definition, so the message an attendee receives and the question the
 * door asks cannot disagree about who is on which list.
 *
 * Accepted beats waitlisted, the same precedence rosterDecision applies (see
 * engine/decision-summary.ts): a director-track applicant can hold a WAITLIST
 * from one department and an ACCEPT from another, and the acceptance is the
 * outcome that decides what they owe.
 *
 * `Applicant.emailLower` is maintained as lower(email) by the submission service
 * and backs a unique index, so both halves are index hits rather than scans with
 * a case-insensitive comparison.
 */
export async function resolveApplicantStanding(
  email: string | null,
  cycleId: string | null,
): Promise<ApplicantStanding> {
  if (!email || !cycleId) return "unknown";
  const emailLower = email.trim().toLowerCase();
  if (emailLower.length === 0) return "unknown";

  const accepted = await prisma.acceptance.findFirst({
    where: { application: { cycleId, applicant: { emailLower } } },
    select: { id: true },
  });
  if (accepted) return "accepted";

  // The same predicate services/review.ts listWaitlisted uses, for the same two
  // tracks: a volunteer is waitlisted on the application itself, a director on
  // an individual department's interview. DRAFT was never submitted and
  // WITHDRAWN removed themselves, so neither is on anybody's waitlist.
  const waitlisted = await prisma.application.findFirst({
    where: {
      cycleId,
      status: "SUBMITTED",
      applicant: { emailLower },
      OR: [{ decision: "WAITLIST" }, { interviews: { some: { decision: "WAITLIST" } } }],
    },
    select: { id: true },
  });
  return waitlisted ? "waitlisted" : "unknown";
}

/**
 * Was this address accepted into this cycle?
 *
 * The accepted/not question, for callers that genuinely only have two branches
 * to choose between. Everything that has something different to say to a
 * waitlisted applicant should read resolveApplicantStanding instead.
 */
export async function isAcceptedApplicantEmail(
  email: string | null,
  cycleId: string | null,
): Promise<boolean> {
  return (await resolveApplicantStanding(email, cycleId)) === "accepted";
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
