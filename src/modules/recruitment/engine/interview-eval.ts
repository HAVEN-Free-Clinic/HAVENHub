export type Recommendation = "STRONG_YES" | "YES" | "MAYBE" | "NO";

export function evaluationSummary(
  evaluations: { recommendation: Recommendation }[]
): { strongYes: number; yes: number; maybe: number; no: number; total: number } {
  const s = { strongYes: 0, yes: 0, maybe: 0, no: 0, total: evaluations.length };
  for (const e of evaluations) {
    if (e.recommendation === "STRONG_YES") s.strongYes += 1;
    else if (e.recommendation === "YES") s.yes += 1;
    else if (e.recommendation === "MAYBE") s.maybe += 1;
    else if (e.recommendation === "NO") s.no += 1;
  }
  return s;
}

/** Panelist ids who have not submitted an evaluation, preserving input order. */
export function missingPanelists(
  panelistIds: string[],
  evaluations: { evaluatorId: string }[]
): string[] {
  const submitted = new Set(evaluations.map((e) => e.evaluatorId));
  return panelistIds.filter((id) => !submitted.has(id));
}
