/**
 * Reconciliation for wallet badges.
 *
 * The vendor has no webhooks and no status endpoint, and every revoke path in
 * the app is best-effort, so nothing else guarantees a badge actually dies. This
 * sweep is that guarantee: it re-revokes anything whose term has ended, whose
 * person has been offboarded, or whose person no longer holds a place here, and
 * it is safe to run repeatedly because vendor deletes are documented no-ops.
 */

import type { Prisma } from "@prisma/client";
import { prisma } from "@/platform/db";
import { log } from "@/platform/logging";
import { OFFBOARDABLE_TERM } from "@/platform/people";
import { todayMarker } from "./term-day";
import { isWalletEnabled, revokePass } from "./wallet-client";

/**
 * Most badges one run will touch.
 *
 * Sized against the ceiling, not picked: the cron route declares
 * maxDuration = 300, and every revoke is a vendor round trip bounded by
 * wallet-client's 8s REQUEST_TIMEOUT_MS. At SWEEP_CONCURRENCY in flight that is
 * 150 / 6 * 8s = 200s of worst-case latency, inside the window with headroom for
 * the database writes. Raising either number needs this arithmetic redone, the
 * same rule MAX_BULK_OFFBOARD carries in volunteers/transition-limits.ts.
 *
 * A bound is necessary because the population goes stale ALL AT ONCE: every
 * badge for a term whose endDate has passed becomes sweepable on the same day.
 * Unbounded, that run ran past maxDuration and was killed mid-loop.
 */
const SWEEP_BATCH = 150;

/**
 * Revokes in flight at once. Bounded rather than Promise.all over the batch, for
 * the reason packages.ts bounds its uploads: a fan-out of hundreds of sockets
 * against a vendor that is already slow is how a fix for a timeout becomes a
 * different timeout. Six is deliberately modest -- this is a background
 * reconciliation with a whole day before the next run, so throughput only has to
 * beat the rate badges go stale.
 */
const SWEEP_CONCURRENCY = 6;

/**
 * Run `task` over `items` with at most `limit` in flight, CONTINUING past a
 * failure.
 *
 * Deliberately not the fail-fast mapWithConcurrency in learning/packages.ts: that
 * one aborts the whole run on the first rejection, which is right for an upload
 * that must be all-or-nothing and exactly wrong here. This is a reconciliation
 * sweep -- one badge the vendor will not delete must not stop the other 149 from
 * being revoked, which is the failure the serial loop had.
 */
async function forEachBounded<T>(
  items: T[],
  limit: number,
  task: (item: T) => Promise<void>
): Promise<void> {
  let cursor = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      await task(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

export async function sweepWalletPasses(): Promise<{ revoked: number; failed: number }> {
  if (!isWalletEnabled()) return { revoked: 0, failed: 0 };

  const today = await todayMarker();

  // Hoisted so the batch query and the backlog count below cannot drift apart.
  const staleWhere = {
    revokedAt: null,
    OR: [
      // A CALENDAR-day comparison, not an instant one: endDate is a noon-UTC
      // marker, so `lt: new Date()` made every badge for a term ending today
      // sweepable from 08:00 ET onwards, killing badges in the middle of the
      // term's final clinic day (audit 14). See term-day.ts.
      { term: { endDate: { lt: today } } },
      { person: { status: "OFFBOARDED" } },
      // The badge asserts PRESENT standing, and Person.status alone does not
      // express it: withdrawFromTerm and a mid-term roster removal both flip
      // memberships to REMOVED while leaving Person.status ACTIVE, so before
      // audit 14 a member who quit in week 2 kept a scannable badge claiming
      // current standing until the term ended.
      //
      // OFFBOARDABLE_TERM is the same non-archived scope offboarding uses to
      // answer "does this person still have a place here" -- shared, not
      // re-spelled, because the two must not drift apart.
      { person: { memberships: { none: { status: "ACTIVE", ...OFFBOARDABLE_TERM } } } },
    ],
  } satisfies Prisma.WalletPassWhereInput;

  const stale = await prisma.walletPass.findMany({
    where: staleWhere,
    select: { id: true, serialNumber: true },
    // Oldest issue first, so the badges that have been asserting standing they
    // no longer have for the longest die first. `id` is a total tiebreak, making
    // the order deterministic across runs -- without one, a truncated run and
    // the next run could disagree about what "the first 150" are and leave a
    // pass permanently unvisited.
    orderBy: [{ issuedAt: "asc" }, { id: "asc" }],
    // One more than the batch, purely to detect truncation for the log below.
    take: SWEEP_BATCH + 1,
  });

  // Never truncate silently: a sweep that quietly did 150 of 400 reads, from its
  // own log line, exactly like a sweep that finished. Successful revokes stamp
  // revokedAt and so leave the query, meaning the remainder is picked up on the
  // next run rather than dropped -- but that is only true if somebody knows to
  // expect a next run.
  const truncated = stale.length > SWEEP_BATCH;
  const batch = truncated ? stale.slice(0, SWEEP_BATCH) : stale;

  let revoked = 0;
  let failed = 0;
  await forEachBounded(batch, SWEEP_CONCURRENCY, async (pass) => {
    try {
      if (!(await revokePass(pass.serialNumber))) {
        failed += 1;
        return;
      }
      await prisma.walletPass.update({ where: { id: pass.id }, data: { revokedAt: new Date() } });
      revoked += 1;
    } catch (err) {
      // revokePass degrades vendor errors to `false` rather than throwing, so
      // reaching here means the database write failed. Count it and carry on:
      // the badge is already dead at the vendor, the row just did not record it,
      // and the next run will retry the pair. Letting it propagate would abort
      // the sweep and abandon every pass after this one.
      failed += 1;
      log.warn("[passport] wallet sweep could not record a revoke", {
        serialNumber: pass.serialNumber,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  // The real size of the backlog, not `stale.length - SWEEP_BATCH`: the query
  // takes only SWEEP_BATCH + 1 rows, so that subtraction is always 1 and would
  // report a 400-badge backlog as "1 deferred". Counting costs one cheap query
  // and only on the truncated path, which is the run where the number matters.
  // Counted AFTER the revokes, so the rows this run already stamped have left
  // the predicate and are not subtracted a second time.
  const deferredToNextRun = truncated ? await prisma.walletPass.count({ where: staleWhere }) : 0;

  if (revoked || failed || truncated) {
    log.info("[passport] wallet sweep", { revoked, failed, deferredToNextRun });
  }
  return { revoked, failed };
}
