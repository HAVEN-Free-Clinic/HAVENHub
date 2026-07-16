/** Mean of a set of 1-5 scores. `average` is null when there are no scores. */
export function scoreAverage(scores: number[]): { average: number | null; count: number } {
  if (scores.length === 0) return { average: null, count: 0 };
  const sum = scores.reduce((a, b) => a + b, 0);
  return { average: sum / scores.length, count: scores.length };
}
