/**
 * Re-measure every unlinked attendance row and write down what it actually owes.
 *
 * The nudge stream already re-measures rather than replaying the snapshot each
 * row was written with, so an unlinked row whose standing has changed since
 * check-in corrects itself on the next pass -- a waitlisted applicant recorded by
 * hand before the door could list the waitlist stops being chased for an
 * onboarding contract that is minted from an acceptance they do not have.
 *
 * That self-correction reaches everything the SWEEP reaches, and the sweep is
 * deliberately narrow: `resolvedAt: null`, under the attempt cap, and on an event
 * inside the lookback window. A row that was chased to the cap, or whose event
 * has scrolled out of the window, is never looked at again and keeps a
 * blockersAtCheckIn array that has been wrong since the day the decision landed.
 * Those rows are out of the email stream too, so nothing is being sent about
 * them -- but the record still says the clinic is waiting on paperwork from
 * somebody it is actually waiting on a decision about.
 *
 * This is the one-off that settles them, for a reader rather than for a send.
 *
 * Both directions, not just the closing one. Resolving is the common case (the
 * waitlisted rows this was written for), but a row resolved while its applicant
 * was waitlisted is stale again the moment they are promoted and owe a contract,
 * and a reconcile that only ever closes rows is a ratchet that quietly stops
 * chasing them. Re-opening restores nudgeCount's own cap, so it never turns into
 * a fresh round of email for somebody already chased three times.
 *
 * Safe to re-run: every write is derived from the current standing, so a second
 * pass over an already-settled row reports `unchanged` and writes nothing.
 */

import { prisma } from "@/platform/db";
import { resolveWalkUpBlockers } from "./attendance-blockers";
import type { OutstandingItemKey } from "./outstanding-items";

export type AttendanceStandingOutcome =
  /** Nothing outstanding any more; taken out of the stream. */
  | "resolved"
  /** Something is outstanding again; put back into it. */
  | "reopened"
  /** The items changed, but not whether anything is owed. */
  | "rewritten"
  | "unchanged";

export type AttendanceStandingRow = {
  attendanceId: string;
  attendeeName: string | null;
  attendeeEmail: string;
  eventTitle: string;
  outcome: AttendanceStandingOutcome;
  /** What the row said it owed. */
  before: string[];
  /** What it owes now. */
  after: OutstandingItemKey[];
};

export type AttendanceStandingResult = {
  rows: AttendanceStandingRow[];
  counts: Record<AttendanceStandingOutcome, number>;
};

/** Same keys, order aside. Sorted rather than compared pairwise so a difference
 *  in emission order alone never counts as a change worth writing. */
function sameKeys(before: readonly string[], after: readonly string[]): boolean {
  if (before.length !== after.length) return false;
  const a = [...before].sort();
  const b = [...after].sort();
  return a.every((key, i) => key === b[i]);
}

export async function reconcileAttendanceStanding(
  opts: { dryRun: boolean; now?: Date } = { dryRun: true },
): Promise<AttendanceStandingResult> {
  const now = opts.now ?? new Date();

  // Unlinked rows only. A row with a Person is measured from clearance, which is
  // live by construction and has its own surfaces; there is no snapshot to have
  // gone stale. A row with no email cannot be matched to anybody at all.
  const rows = await prisma.eventAttendance.findMany({
    where: { personId: null, attendeeEmail: { not: null } },
    orderBy: { checkedInAt: "asc" },
    select: {
      id: true,
      attendeeName: true,
      attendeeEmail: true,
      blockersAtCheckIn: true,
      resolvedAt: true,
      event: { select: { title: true, cycleId: true } },
    },
  });

  // One lookup per (cycle, address), not per row: somebody who came to the info
  // session and the training is two rows and one answer, and the standing query
  // is the expensive part of this pass.
  const standingCache = new Map<string, Awaited<ReturnType<typeof resolveWalkUpBlockers>>>();
  const blockersFor = async (email: string, cycleId: string | null) => {
    const key = `${cycleId ?? ""}|${email}`;
    const hit = standingCache.get(key);
    if (hit) return hit;
    const measured = await resolveWalkUpBlockers(email, cycleId);
    standingCache.set(key, measured);
    return measured;
  };

  const out: AttendanceStandingRow[] = [];
  const counts: Record<AttendanceStandingOutcome, number> = {
    resolved: 0,
    reopened: 0,
    rewritten: 0,
    unchanged: 0,
  };

  for (const row of rows) {
    const email = row.attendeeEmail as string;
    const measured = await blockersFor(email, row.event.cycleId);

    const keysChanged = !sameKeys(row.blockersAtCheckIn, measured.keys);
    const shouldBeResolved = measured.keys.length === 0;
    const isResolved = row.resolvedAt !== null;

    const outcome: AttendanceStandingOutcome =
      shouldBeResolved && !isResolved
        ? "resolved"
        : !shouldBeResolved && isResolved
          ? "reopened"
          : keysChanged
            ? "rewritten"
            : "unchanged";

    out.push({
      attendanceId: row.id,
      attendeeName: row.attendeeName,
      attendeeEmail: email,
      eventTitle: row.event.title,
      outcome,
      before: row.blockersAtCheckIn,
      after: measured.keys,
    });
    counts[outcome] += 1;

    if (outcome === "unchanged" || opts.dryRun) continue;

    await prisma.eventAttendance.update({
      where: { id: row.id },
      data: {
        blockersAtCheckIn: measured.keys,
        // Stamped `now` rather than the check-in time: this is when the clinic
        // established there was nothing left to chase, which is today, not the
        // evening they walked through the door.
        resolvedAt: shouldBeResolved ? (row.resolvedAt ?? now) : null,
      },
    });
  }

  return { rows: out, counts };
}
