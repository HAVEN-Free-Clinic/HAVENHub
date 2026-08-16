import type { HistoricalOutcome, HistoricalStage, Track } from "@prisma/client";

export type StageSignals = {
  advanced: boolean;
  finalRound: boolean;
  accepted: boolean;
  onboarded: boolean;
};

/**
 * The furthest stage reached, checked highest-first. Deliberately does NOT
 * require the lower rungs to be set: several old cycles recorded an acceptance
 * without ever populating a selection row (V-SP26 records nothing but an
 * ACCEPTED? checkbox), and demanding a contiguous ladder would silently
 * downgrade those to APPLIED.
 */
export function deriveStage(s: StageSignals): HistoricalStage {
  if (s.onboarded) return "ONBOARDED";
  if (s.accepted) return "ACCEPTED";
  if (s.finalRound) return "FINAL_ROUND";
  if (s.advanced) return "ADVANCED";
  return "APPLIED";
}

/**
 * Ordered: the FIRST matching pattern wins, so the order encodes real
 * precedence decisions rather than style.
 *
 * Every pattern is derived from the actual distinct values across all ten
 * source bases, tallied 2026-08-05, not from guesswork:
 *
 *   Approved 1270, Confirmed 827, Rejected 618,
 *   "Rejection - Department Capacity" 163, "Rejection - Ineligible Applicant" 19,
 *   "Rejection - Other" 19, "R2 Deferral" 10, Ineligible 5, Pending 2,
 *   Withdrawn 1, "Awaiting Confirmation" 1
 *
 * Note that "Approved" and "Confirmed", not "Accepted", are how these bases
 * actually spell an acceptance. They are 2097 of the 2131 acceptances.
 *
 * Two orderings are load-bearing:
 *
 *   INELIGIBLE precedes REJECTED so "Rejection - Ineligible Applicant" lands
 *   as INELIGIBLE. Ops ruled those applicants were not turned down on merit,
 *   so a later reapplication must not read as a prior rejection.
 *
 *   The in-flight patterns precede ACCEPTED so "Awaiting Confirmation" is not
 *   swallowed by the "Confirmed" rule. ACCEPTED is anchored with ^ for the
 *   same reason. Do not relax it to a substring match.
 */
const OUTCOMES: Array<[RegExp, HistoricalOutcome]> = [
  [/ineligib/i, "INELIGIBLE"],
  [/^(pending|awaiting)/i, "NO_DECISION"],
  [/defer/i, "NO_DECISION"],
  [/^(approve|confirm|accept)/i, "ACCEPTED"],
  [/^(reject|den(y|ied))/i, "REJECTED"],
  [/^wait ?list/i, "WAITLISTED"],
  [/^withdr/i, "WITHDRAWN"],
];

/**
 * NO_DECISION means the source recorded nothing. UNKNOWN means it recorded
 * something this mapper does not understand: the two must stay distinct so the
 * dry-run report can surface real vocabulary drift instead of burying it in
 * the same bucket as the (very common) blank cell.
 */
export function parseOutcome(raw: string | null | undefined): HistoricalOutcome {
  const value = raw?.trim();
  if (!value) return "NO_DECISION";
  for (const [pattern, outcome] of OUTCOMES) if (pattern.test(value)) return outcome;
  return "UNKNOWN";
}

export function stageLabel(stage: HistoricalStage, track: Track): string {
  switch (stage) {
    case "APPLIED": return "Applied";
    case "ADVANCED": return "Advanced";
    case "FINAL_ROUND": return track === "DIRECTOR" ? "Interviewed" : "Round 2";
    case "ACCEPTED": return "Accepted";
    case "ONBOARDED": return "Onboarded";
  }
}
