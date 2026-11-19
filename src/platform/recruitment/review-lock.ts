import { cache } from "react";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/platform/db";
import { isOwnApplication } from "./own-application";
import { reviewerIdentity } from "./reviewer-identity";

/**
 * The cycle review lock, read side.
 *
 * Anyone with an application in a recruitment cycle sees none of that cycle's
 * applicants, themselves included, whatever roles they hold: a lead, an ED or an
 * admin who applied is locked out exactly like a director who applied. "Has an
 * application" means an Applicant row for the cycle, whatever its state: a
 * draft, a submission or a withdrawal all count, and the lock never lifts for
 * that cycle. Discarding a draft deletes the row, and with it the lock. Other
 * cycles are unaffected.
 *
 * Who the viewer is matched on is own-application.ts's question (account link,
 * NetID, or an address they are known by), not the account link alone: the link
 * is missing whenever the applicant submitted signed out (#889).
 *
 * A recruitment.review_all holder can grant a named person a per-cycle
 * exception (CycleReviewException). It lets them back into the cycle but never
 * into their own application: callers drop `ownApplicantIds` from everything
 * they return and refuse every write against it.
 *
 * This file is the read side, in platform so the language queue and the
 * schedule builder's incoming roster can apply it. The recruitment module's
 * services/review-lock.ts adds the errors, the write guards and the exception
 * management, and re-exports all of this.
 */

/** `clear`: no application in the cycle. `locked`: has one, no exception.
 *  `excepted`: has one, with an exception, so sees everything but their own. */
export type ReviewLockState = "clear" | "locked" | "excepted";

export type CycleReviewLock = {
  state: ReviewLockState;
  /** Set (true) only when every one of the viewer's applications here matched
   *  on the NetID typed into the application alone, never their account link
   *  or an email they are known by. That NetID is self-asserted for applicants
   *  who signed in with a non-Yale address, so the lock still holds (a missed
   *  match would leak applicants) but the notice says why, so a mistyped or
   *  spoofed NetID gets noticed and corrected rather than silently locking a
   *  lead out. */
  netIdOnly?: boolean;
  /** The viewer's own Applicant ids in this cycle (usually one). Empty when
   *  clear. Nothing that belongs to one of these may reach them. */
  ownApplicantIds: string[];
};

type ViewerApplications = {
  /** cycleId -> the viewer's Applicant ids in it. */
  byCycle: Map<string, string[]>;
  /** Cycles where at least one own application matched on link or email. */
  stronglyMatchedCycleIds: Set<string>;
  exceptedCycleIds: Set<string>;
};

/**
 * Every Applicant row that is the viewer's, across all cycles, and every cycle
 * they hold an exception for. One pair of queries per request however many
 * cycles and rows a render asks about (React cache, like reviewScope).
 */
const viewerApplications = cache(async (viewerId: string): Promise<ViewerApplications> => {
  const me = await reviewerIdentity(viewerId);
  const or: Prisma.ApplicantWhereInput[] = [{ applicantPersonId: viewerId }];
  if (me.netId) or.push({ netId: { equals: me.netId, mode: "insensitive" } });
  if (me.emails.length > 0) or.push({ emailLower: { in: me.emails } });
  const [candidates, exceptions] = await Promise.all([
    prisma.applicant.findMany({
      // Test runs never lock: their applicants are made up, and the team
      // rehearses a cycle by applying to its test run and then reviewing it.
      // Someone who did that has not applied to anything (the history card
      // agrees). The own-application guards on scoring and deciding still
      // apply there.
      where: { OR: or, cycle: { isTest: false } },
      select: { id: true, cycleId: true, applicantPersonId: true, emailLower: true, netId: true },
    }),
    prisma.cycleReviewException.findMany({ where: { personId: viewerId }, select: { cycleId: true } }),
  ]);
  const byCycle = new Map<string, string[]>();
  // The query narrows; the matcher decides, so the lock can never disagree with
  // the own-application guard about who someone is.
  const stronglyMatchedCycleIds = new Set<string>();
  for (const a of candidates) {
    if (!isOwnApplication(a, me)) continue;
    byCycle.set(a.cycleId, [...(byCycle.get(a.cycleId) ?? []), a.id]);
    // isOwnApplication with the NetID taken away: a verified identifier matched.
    if (isOwnApplication({ ...a, netId: null }, me)) stronglyMatchedCycleIds.add(a.cycleId);
  }
  return { byCycle, stronglyMatchedCycleIds, exceptedCycleIds: new Set(exceptions.map((e) => e.cycleId)) };
});

/** Where this viewer stands in one cycle. Cached per request. */
export async function cycleReviewLock(cycleId: string, viewerId: string): Promise<CycleReviewLock> {
  const { byCycle, stronglyMatchedCycleIds, exceptedCycleIds } = await viewerApplications(viewerId);
  const own = byCycle.get(cycleId) ?? [];
  if (own.length === 0) return { state: "clear", ownApplicantIds: [] };
  return {
    state: exceptedCycleIds.has(cycleId) ? "excepted" : "locked",
    ownApplicantIds: own,
    ...(stronglyMatchedCycleIds.has(cycleId) ? {} : { netIdOnly: true }),
  };
}

/** Cycles whose applicants this viewer must not see at all. */
export async function lockedCycleIds(viewerId: string): Promise<string[]> {
  const { byCycle, exceptedCycleIds } = await viewerApplications(viewerId);
  return [...byCycle.keys()].filter((id) => !exceptedCycleIds.has(id));
}

/** The viewer's own Applicant ids in every cycle. */
export async function ownApplicantIds(viewerId: string): Promise<string[]> {
  const { byCycle } = await viewerApplications(viewerId);
  return [...byCycle.values()].flat();
}

/** Whether one application is hidden from a viewer, given the lock for ITS cycle. */
export function isHiddenByLock(app: { applicantId: string }, lock: CycleReviewLock): boolean {
  return lock.state === "locked" || lock.ownApplicantIds.includes(app.applicantId);
}

/**
 * A where-clause for applications the viewer may see as far as the lock goes:
 * not in a locked cycle, and not their own. `{}` when nothing is hidden. Put it
 * in an AND beside the caller's own filters (or under a relation key), never
 * spread it, so it cannot overwrite a `cycleId` the caller set.
 */
export async function visibleApplicationWhere(viewerId: string): Promise<Prisma.ApplicationWhereInput> {
  const [locked, own] = await Promise.all([lockedCycleIds(viewerId), ownApplicantIds(viewerId)]);
  const and: Prisma.ApplicationWhereInput[] = [];
  if (locked.length > 0) and.push({ cycleId: { notIn: locked } });
  if (own.length > 0) and.push({ applicantId: { notIn: own } });
  return and.length > 0 ? { AND: and } : {};
}
