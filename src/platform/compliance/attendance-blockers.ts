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
 * What an unlinked walk-up is told, in place of a clearance list nobody can
 * compute for them. Phrased for someone who may not have applied at all, which
 * is why it does not reuse the shared `contract` sentence (that one speaks to an
 * accepted applicant who owes a contract). Shared by the check-in path and the
 * recurring nudge so the two cannot drift.
 */
export const WALK_UP_BLOCKERS: AttendanceBlockers = {
  keys: ["contract"],
  items: ["Submit an application and onboarding contract so your attendance can be credited"],
};

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
