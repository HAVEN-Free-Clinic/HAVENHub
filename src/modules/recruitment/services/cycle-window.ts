/**
 * A recruitment cycle accepts applications when its status is OPEN and now falls
 * within its optional [opensAt, closesAt] window (both bounds inclusive; a null
 * bound means unbounded on that side).
 *
 * This is the single source of truth for the applicant-facing "is this cycle
 * accepting applications" gate. The public apply form, draft save/submit paths,
 * and the portal status list must all agree on it, so the "Continue" affordance
 * on the portal home never points at a form the destination will reject.
 */
export function isCycleOpen(
  cycle: { status: string; opensAt: Date | null; closesAt: Date | null },
  now: Date,
): boolean {
  return (
    cycle.status === "OPEN" &&
    (!cycle.opensAt || cycle.opensAt <= now) &&
    (!cycle.closesAt || cycle.closesAt >= now)
  );
}
