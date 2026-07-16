import { scoreAverage } from "./scoring";

export function evaluationSummary(
  evaluations: { score: number }[],
): { average: number | null; count: number } {
  return scoreAverage(evaluations.map((e) => e.score));
}

/** Panelist ids who have not submitted an evaluation, preserving input order. */
export function missingPanelists(
  panelistIds: string[],
  evaluations: { evaluatorId: string }[],
): string[] {
  const submitted = new Set(evaluations.map((e) => e.evaluatorId));
  return panelistIds.filter((id) => !submitted.has(id));
}
