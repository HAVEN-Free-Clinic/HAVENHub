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
 *
 * `target` is the cycle's scoresPerApplication, and is null on a cycle that
 * never set a scorer pool. When one is set and this application has not reached
 * it, the count reads "2 of 3": an average over two reads and an average over
 * three are not comparable, and the routing percentile ranks them side by side,
 * so the lead needs to see which rows are still short. The target disappears
 * once met, rather than sitting there as "3 of 3" on every settled row.
 */
export function formatScoreSummary(
  { average, count }: { average: number | null; count: number },
  target?: number | null,
): string {
  const short = target != null && target > count;
  if (average == null) return short ? `Not yet scored · ${count} of ${target}` : "Not yet scored";
  const reviewers = short ? `${count} of ${target}` : String(count);
  // "1 of 3 reviewer" is wrong: the noun agrees with the target being counted
  // toward, not with how many have come in so far.
  return `${average.toFixed(1)} avg · ${reviewers} ${count === 1 && !short ? "reviewer" : "reviewers"}`;
}
