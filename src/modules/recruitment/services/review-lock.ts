import { prisma, isUniqueConstraintError } from "@/platform/db";
import { can } from "@/platform/rbac/engine";
import { recordAudit } from "@/platform/audit";
import { log } from "@/platform/logging";
import { PERSON_NAME_ORDER } from "@/platform/person-name";
import { cycleReviewLock, type CycleReviewLock } from "@/platform/recruitment/review-lock";
import { RecruitmentAuthError } from "./errors";

// The read side lives in platform so platform code (the language queue, the
// schedule builder's incoming roster) can apply it too. Re-exported here so the
// recruitment module has one place to import the lock from.
export {
  cycleReviewLock,
  lockedCycleIds,
  ownApplicantIds,
  isHiddenByLock,
  visibleApplicationWhere,
  type CycleReviewLock,
  type ReviewLockState,
} from "@/platform/recruitment/review-lock";

/**
 * The cycle review lock.
 *
 * Anyone with an application in a recruitment cycle sees none of that cycle's
 * applicants, themselves included, whatever roles they hold: a lead, an ED or an
 * admin who applied is locked out exactly like a director who applied. "Has an
 * application" means an Applicant row for the cycle, whatever its state: a
 * draft, a submission or a withdrawal all count, and the lock never lifts for
 * that cycle. Discarding a draft deletes the row, and with it the lock. Other
 * cycles are unaffected.
 *
 * Who the viewer is matched on is engine/own-application.ts's question (account
 * link, NetID, or an address they are known by), not the account link alone:
 * the link is missing whenever the applicant submitted signed out (#889).
 *
 * A recruitment.review_all holder can grant a named person a per-cycle
 * exception (CycleReviewException) for logistical reasons within their
 * department. The exception lets them back into the cycle but never into their
 * own application: callers drop `ownApplicantIds` from everything they return
 * and refuse every write against it.
 *
 * This is enforced in the services, not the pages: a page is not the security
 * boundary (a layout does not even stop the page under it from rendering), and
 * the MCP tools, cron digests and server actions reach the services without one.
 */

export const CYCLE_LOCKED_MESSAGE = "You have applied in this cycle, so its applicants are hidden from you.";
export const OWN_APPLICATION_MESSAGE = "You can't act on your own application.";

/** Thrown when a locked viewer reaches a cycle's applicants. A
 *  RecruitmentAuthError, so every action that already turns those into a calm
 *  message handles it unchanged. */
export class CycleLockedError extends RecruitmentAuthError {
  constructor() { super(CYCLE_LOCKED_MESSAGE); this.name = "CycleLockedError"; }
}

export class ReviewExceptionError extends Error {
  constructor(message: string) { super(message); this.name = "ReviewExceptionError"; }
}


/** Throw CycleLockedError when the viewer is locked out of this cycle. Returns
 *  the lock so the caller can still drop the viewer's own rows when excepted. */
export async function assertCycleUnlocked(cycleId: string, viewerId: string): Promise<CycleReviewLock> {
  const lock = await cycleReviewLock(cycleId, viewerId);
  if (lock.state === "locked") throw new CycleLockedError();
  return lock;
}

export const CYCLE_WIDE_EXCEPTED_MESSAGE =
  "You have an application in this cycle, so its cycle-wide steps (decisions, release, onboarding, scoring and subcommittee assignment) are run by another recruitment lead.";

/**
 * For the cycle-wide steps that necessarily touch every applicant at once
 * (Decisions and Release, rejection and waitlist emails, onboarding, the scorer
 * allocation, subcommittee assignment): only someone with NO application in the
 * cycle. An exception does not reach these, since each would include the
 * holder's own application; other recruitment leads run them.
 */
export async function assertCycleClear(cycleId: string, viewerId: string): Promise<void> {
  const lock = await assertCycleUnlocked(cycleId, viewerId);
  if (lock.state === "excepted") throw new RecruitmentAuthError(CYCLE_WIDE_EXCEPTED_MESSAGE);
}

/** assertCycleClear for a batch of onboarding contracts or acceptances, which
 *  carry their cycle only through the application. Missing ids pass, so the
 *  caller's own "not found" handling still reads. */
export async function assertCycleClearFor(
  ids: { contractIds?: string[]; acceptanceIds?: string[] },
  actorId: string,
): Promise<void> {
  const cycleIds = new Set<string>();
  if (ids.contractIds?.length) {
    const rows = await prisma.onboardingContract.findMany({
      where: { id: { in: ids.contractIds } },
      select: { acceptance: { select: { application: { select: { cycleId: true } } } } },
    });
    for (const r of rows) cycleIds.add(r.acceptance.application.cycleId);
  }
  if (ids.acceptanceIds?.length) {
    const rows = await prisma.acceptance.findMany({
      where: { id: { in: ids.acceptanceIds } },
      select: { application: { select: { cycleId: true } } },
    });
    for (const r of rows) cycleIds.add(r.application.cycleId);
  }
  for (const cycleId of cycleIds) await assertCycleClear(cycleId, actorId);
}

/**
 * Refuse a write on one application by someone the lock keeps away from it:
 * locked out of its cycle, or (even with an exception) acting on their own.
 * `message` overrides the own-application wording, so a caller can keep its
 * existing "You can't score your own application." text.
 */
export async function assertMayActOnApplication(
  app: { cycleId: string; applicantId: string },
  actorId: string,
  message: string = OWN_APPLICATION_MESSAGE,
): Promise<void> {
  const lock = await assertCycleUnlocked(app.cycleId, actorId);
  if (lock.ownApplicantIds.includes(app.applicantId)) throw new RecruitmentAuthError(message);
}

/** assertMayActOnApplication for a caller holding only the id. A missing
 *  application passes, so the caller's own "not found" error still reads. */
export async function assertMayActOnApplicationId(applicationId: string, actorId: string, message?: string): Promise<void> {
  const app = await prisma.application.findUnique({ where: { id: applicationId }, select: { cycleId: true, applicantId: true } });
  if (app) await assertMayActOnApplication(app, actorId, message);
}

// ---------------------------------------------------------------------------
// Exceptions
// ---------------------------------------------------------------------------

const REASON_MAX = 500;

export type ReviewExceptionRow = {
  personId: string;
  personName: string;
  reason: string;
  grantedByName: string;
  createdAt: Date;
};

async function assertMayManageExceptions(cycleId: string, actorId: string): Promise<void> {
  if (!(await can(actorId, "recruitment.review_all"))) {
    throw new RecruitmentAuthError("Only a recruitment lead can grant or revoke review exceptions.");
  }
  // A lead who applied in this cycle cannot manage its lock, exception or not:
  // that would let an applicant grant themselves, or a fellow applicant, a way
  // back in. Only a review_all holder with no application here runs it.
  await assertCycleClear(cycleId, actorId);
}

/** Let a named person review a cycle they applied in (never their own
 *  application). Requires a reason; records who granted it and when. */
export async function grantReviewException(
  cycleId: string,
  personId: string,
  reason: string,
  actorId: string,
): Promise<void> {
  await assertMayManageExceptions(cycleId, actorId);
  const why = reason.trim();
  if (!why) throw new ReviewExceptionError("Give a reason for the exception.");
  if (why.length > REASON_MAX) throw new ReviewExceptionError(`Keep the reason under ${REASON_MAX} characters.`);
  if (personId === actorId) throw new ReviewExceptionError("You can't grant yourself an exception.");
  const [cycle, person] = await Promise.all([
    prisma.recruitmentCycle.findUnique({ where: { id: cycleId }, select: { id: true } }),
    prisma.person.findUnique({ where: { id: personId }, select: { id: true } }),
  ]);
  if (!cycle) throw new ReviewExceptionError("Cycle not found.");
  if (!person) throw new ReviewExceptionError("Pick a person to grant the exception to.");
  try {
    await prisma.cycleReviewException.create({ data: { cycleId, personId, reason: why, grantedById: actorId } });
  } catch (err) {
    if (isUniqueConstraintError(err)) throw new ReviewExceptionError("That person already has an exception for this cycle.");
    throw err;
  }
  await recordAudit({
    actorPersonId: actorId,
    action: "recruitment.review_exception_grant",
    entityType: "RecruitmentCycle",
    entityId: cycleId,
    after: { personId, reason: why },
  });
  log.info("recruitment.review_exception_grant", { cycleId, personId, actorId });
}

/** Withdraw an exception. The row is deleted; the audit entry keeps the reason. */
export async function revokeReviewException(cycleId: string, personId: string, actorId: string): Promise<void> {
  await assertMayManageExceptions(cycleId, actorId);
  const existing = await prisma.cycleReviewException.findUnique({ where: { cycleId_personId: { cycleId, personId } } });
  if (!existing) throw new ReviewExceptionError("That exception was already revoked.");
  await prisma.cycleReviewException.deleteMany({ where: { id: existing.id } });
  await recordAudit({
    actorPersonId: actorId,
    action: "recruitment.review_exception_revoke",
    entityType: "RecruitmentCycle",
    entityId: cycleId,
    before: { personId, reason: existing.reason, grantedById: existing.grantedById, grantedAt: existing.createdAt.toISOString() },
  });
  log.info("recruitment.review_exception_revoke", { cycleId, personId, actorId });
}

/** The cycle's exceptions, oldest first, for the cycle overview. */
export async function listReviewExceptions(cycleId: string): Promise<ReviewExceptionRow[]> {
  const rows = await prisma.cycleReviewException.findMany({
    where: { cycleId },
    include: { person: { select: { name: true } }, grantedBy: { select: { name: true } } },
    orderBy: { createdAt: "asc" },
  });
  return rows.map((r) => ({
    personId: r.personId,
    personName: r.person.name,
    reason: r.reason,
    grantedByName: r.grantedBy.name,
    createdAt: r.createdAt,
  }));
}

/** People an exception can be granted to: active people without one already. */
export async function listExceptionCandidates(cycleId: string): Promise<{ id: string; name: string }[]> {
  const existing = await prisma.cycleReviewException.findMany({ where: { cycleId }, select: { personId: true } });
  const exclude = existing.map((e) => e.personId);
  return prisma.person.findMany({
    where: { status: "ACTIVE", ...(exclude.length ? { id: { notIn: exclude } } : {}) },
    select: { id: true, name: true },
    orderBy: PERSON_NAME_ORDER,
  });
}
