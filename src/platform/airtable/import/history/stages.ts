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

const OUTCOMES: Array<[RegExp, HistoricalOutcome]> = [
  [/^accept/i, "ACCEPTED"],
  [/^(reject|den(y|ied)|no)$|^reject/i, "REJECTED"],
  [/^wait ?list/i, "WAITLISTED"],
  [/^withdr/i, "WITHDRAWN"],
  [/^ineligib/i, "INELIGIBLE"],
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
