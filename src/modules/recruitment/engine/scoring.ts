/** Mean of a set of 1-5 scores. `average` is null when there are no scores. */
export function scoreAverage(scores: number[]): { average: number | null; count: number } {
  if (scores.length === 0) return { average: null, count: 0 };
  const sum = scores.reduce((a, b) => a + b, 0);
  return { average: sum / scores.length, count: scores.length };
}

/**
 * Human-readable form of a score summary, e.g. "3.7 avg · 3 reviewers". A bare
 * "3.7 · 3" reads as a date or a score line to anyone who hasn't been told what
 * the two numbers mean, so both are labelled wherever a summary is shown.
 */
export function formatScoreSummary({ average, count }: { average: number | null; count: number }): string {
  if (average == null) return "Not yet scored";
  return `${average.toFixed(1)} avg · ${count} ${count === 1 ? "reviewer" : "reviewers"}`;
}
