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

/**
 * May THIS applicant submit to this cycle right now?
 *
 * Distinct from isCycleOpen, which answers a question about the CYCLE and stays
 * the honest public answer (the portal keeps calling it to label a cycle open or
 * closed). This answers a question about a PERSON, because an invited applicant
 * may apply to a cycle that is, correctly, closed to everyone else.
 *
 * An invite bypasses the application WINDOW and the CLOSED status. It does not
 * bypass DRAFT or ARCHIVED, and those two exclusions are the point of the
 * function rather than an afterthought:
 *
 *  - DRAFT: the form is still being built, so answers would be collected against
 *    questions that may still change.
 *  - ARCHIVED: archiving is how a cycle is retired for good. A live invite
 *    against one is a stale link, not a back door, and honoring it would attach a
 *    fresh application to a cycle nobody is reviewing.
 *
 * Every applicant-facing gate (the apply page, draft save, submit) must call
 * THIS, not isCycleOpen, or an invite will work on one path and bounce on
 * another.
 */
export function canSubmitToCycle(
  cycle: { status: string; opensAt: Date | null; closesAt: Date | null },
  now: Date,
  opts: { invited: boolean },
): boolean {
  if (isCycleOpen(cycle, now)) return true;
  return opts.invited && (cycle.status === "OPEN" || cycle.status === "CLOSED");
}
