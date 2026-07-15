/** One row in the speed-score queue. `myScore` is the viewer's own current
 *  score for the application (null when they have not scored it yet). */
export type SpeedScoreItem = {
  applicationId: string;
  name: string;
  typeLabel: string;
  myScore: number | null;
};

/** Build the ordered queue and the starting index for the speed-score modal.
 *  Pure and total: the caller has already filtered out the viewer's own
 *  application. Input order (roster order) is preserved. */
export function buildSpeedScoreQueue(
  items: SpeedScoreItem[],
  opts: { includeScored: boolean },
): { queue: SpeedScoreItem[]; initialIndex: number } {
  if (!opts.includeScored) {
    return { queue: items.filter((i) => i.myScore == null), initialIndex: 0 };
  }
  const firstUnscored = items.findIndex((i) => i.myScore == null);
  return { queue: items, initialIndex: firstUnscored === -1 ? 0 : firstUnscored };
}
