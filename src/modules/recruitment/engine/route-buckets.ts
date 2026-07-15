export type RouteBucketItem = { applicationId: string; average: number | null };
export type RouteBuckets = {
  top: string[];
  middle: string[];
  bottom: string[];
  unscored: string[]; // average == null; excluded from ranking
};

/** Partition applicants into top / middle / bottom by committee average using
 *  per-cycle percentile targets. Ties are never split: when a cut lands inside a
 *  tie, the whole tie resolves in the applicant's favor (into the higher tier).
 *  A tier can therefore exceed its nominal percentage; callers surface real counts. */
export function bucketByPercentile(input: {
  items: RouteBucketItem[];
  topPercent: number;
  bottomPercent: number;
}): RouteBuckets {
  const { items, topPercent, bottomPercent } = input;
  const unscored = items.filter((i) => i.average == null).map((i) => i.applicationId);
  const scored = items.filter(
    (i): i is { applicationId: string; average: number } => i.average != null,
  );
  const N = scored.length;
  if (N === 0) return { top: [], middle: [], bottom: [], unscored };

  // Sort by average desc; break ties by id asc (deterministic display order only;
  // tier membership below is defined purely by average value, never by index).
  const sorted = [...scored].sort(
    (a, b) => b.average - a.average || (a.applicationId < b.applicationId ? -1 : 1),
  );

  const clamp = (n: number, lo: number, hi: number) => Math.min(Math.max(n, lo), hi);
  const topCount = clamp(Math.round((topPercent / 100) * N), 0, N);
  const bottomCount = clamp(Math.round((bottomPercent / 100) * N), 0, N - topCount);

  const topSet = new Set<string>();
  if (topCount > 0) {
    const topThreshold = sorted[topCount - 1].average;
    for (const s of sorted) if (s.average >= topThreshold) topSet.add(s.applicationId);
  }

  const bottomSet = new Set<string>();
  if (bottomCount > 0) {
    const boundaryVal = sorted[N - bottomCount].average;
    const aboveIdx = N - bottomCount - 1;
    // The applicant just above the reject line, unless that slot is already in top.
    const aboveVal =
      aboveIdx >= 0 && !topSet.has(sorted[aboveIdx].applicationId) ? sorted[aboveIdx].average : null;
    const minVal = sorted[N - 1].average; // Last item is minimum in descending sort
    // Straddle: the boundary value appears above the line AND is above the minimum,
    // so spare the whole tie (exclusive cut). Otherwise the boundary tie is clean (inclusive cut).
    const straddle = boundaryVal > minVal && aboveVal != null && aboveVal === boundaryVal;
    for (const s of sorted) {
      if (topSet.has(s.applicationId)) continue;
      if (straddle ? s.average < boundaryVal : s.average <= boundaryVal) {
        bottomSet.add(s.applicationId);
      }
    }
  }

  const top: string[] = [];
  const middle: string[] = [];
  const bottom: string[] = [];
  for (const s of sorted) {
    if (topSet.has(s.applicationId)) top.push(s.applicationId);
    else if (bottomSet.has(s.applicationId)) bottom.push(s.applicationId);
    else middle.push(s.applicationId);
  }
  return { top, middle, bottom, unscored };
}
