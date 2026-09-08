/**
 * Who the door screen's search box is pointing at.
 *
 * Pure, and in its own file rather than inline in the component, because these
 * two functions are the whole safety argument for a check-in that commits on a
 * keystroke. "Enter checks somebody in" is only defensible while the thing Enter
 * resolves to is exact and unambiguous, and that property is worth asserting in
 * tests rather than reading off a component.
 *
 * Matching runs in the browser against a preloaded list: the operator is typing
 * fast with a queue in front of them, and a round trip per character is the wrong
 * trade against a list carrying only names, addresses and netIds.
 */

import type { CheckInCandidate } from "@/modules/recruitment/services/attendance-events";

/**
 * How many rows a query may render.
 *
 * A two-letter query against a full clinic roster otherwise paints hundreds of
 * rows at exactly the moment somebody is typing quickly, and no operator scrolls
 * a door screen -- they type another letter.
 */
export const MAX_RESULTS = 25;

/** Rows matching a free-text query on name, email or netId. Empty query, empty list. */
export function matchCandidates(
  candidates: readonly CheckInCandidate[],
  query: string,
): CheckInCandidate[] {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return [];
  const out: CheckInCandidate[] = [];
  for (const c of candidates) {
    const hit =
      c.name.toLowerCase().includes(q) ||
      (c.email ?? "").toLowerCase().includes(q) ||
      (c.netId ?? "").includes(q);
    if (!hit) continue;
    out.push(c);
    if (out.length === MAX_RESULTS) break;
  }
  return out;
}

/**
 * The one candidate this query is unambiguously naming, or null.
 *
 * Only ever a WHOLE netId. A netId is unique and self-delimiting, so typing one
 * completely is a statement about exactly one person; a prefix is a guess, and a
 * name -- however unambiguous it looks against today's list -- stops being
 * unambiguous the moment a second Carney joins. That asymmetry is the reason
 * Enter is safe here and would not be on the name path.
 *
 * Ties resolve toward the `person` row: Applicant.netId carries no unique
 * constraint, so an applicant whose Person holds a different contact address
 * survives the email dedupe in listCheckInCandidates and shows up beside their
 * own linked row. Checking in the linked one is strictly better -- it credits
 * training immediately instead of waiting for promotion to link an email. A tie
 * the preference cannot break returns null: at a door, doing nothing is
 * recoverable and checking in the wrong person is not.
 */
export function exactNetIdMatch(
  candidates: readonly CheckInCandidate[],
  query: string,
): CheckInCandidate | null {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return null;
  const hits = candidates.filter((c) => c.netId !== null && c.netId === q);
  if (hits.length === 1) return hits[0];
  const people = hits.filter((c) => c.kind === "person");
  return people.length === 1 ? people[0] : null;
}
