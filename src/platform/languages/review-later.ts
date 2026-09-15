/**
 * "Review later" on the language review queue.
 *
 * A reviewer working a long queue can set rows aside to come back to. That
 * moves them off the queue tab onto the Review later tab, and nothing else:
 * no verdict is recorded, nobody is notified, and the person is still owed an
 * assessment. Recording a verdict from either tab clears the deferral (the two
 * queue write paths call the clear helpers below), and "Back to queue" deletes
 * it.
 *
 * Imports nothing from ./index or ./applicant-review, which both call into
 * this module, so the three stay acyclic.
 */

import { prisma } from "@/platform/db";
import { LanguageValidationError, isLanguageCode } from "./catalog";

/** One queue row, in the same shape the bulk bar posts it. A score, if posted, is ignored. */
export type ReviewLaterTarget =
  | { source: "member"; personId: string; language: string }
  | { source: "applicant"; applicationId: string; language: string };

type MemberTarget = Extract<ReviewLaterTarget, { source: "member" }>;
type ApplicantTarget = Extract<ReviewLaterTarget, { source: "applicant" }>;

/**
 * Move rows to Review later (`later: true`) or back to the queue. Returns how
 * many rows actually moved.
 *
 * Only rows still owed an assessment are parked: a member claim with a verdict,
 * or an application language with one, is skipped. The page the reviewer
 * ticked from can be minutes stale, and a deferral on a settled row would do
 * nothing but sit there. A row already parked counts as not moved, so a double
 * submit reports honestly.
 */
export async function setReviewLater(
  actorPersonId: string,
  targets: readonly ReviewLaterTarget[],
  later: boolean,
): Promise<number> {
  for (const t of targets) {
    if (!isLanguageCode(t.language)) {
      throw new LanguageValidationError(`Unknown language "${t.language}".`);
    }
  }
  const members = targets.filter((t): t is MemberTarget => t.source === "member");
  const applicants = targets.filter((t): t is ApplicantTarget => t.source === "applicant");
  if (members.length === 0 && applicants.length === 0) return 0;

  if (!later) {
    const { count } = await prisma.languageReviewDeferral.deleteMany({
      where: {
        OR: [
          ...members.map((t) => ({ personLanguage: { personId: t.personId, language: t.language } })),
          ...applicants.map((t) => ({ applicationId: t.applicationId, language: t.language })),
        ],
      },
    });
    return count;
  }

  const [claims, applications] = await Promise.all([
    members.length === 0
      ? []
      : prisma.personLanguage.findMany({
          where: {
            verifiedAt: null,
            OR: members.map((t) => ({ personId: t.personId, language: t.language })),
          },
          select: { id: true },
        }),
    applicants.length === 0
      ? []
      : prisma.application.findMany({
          where: { id: { in: applicants.map((t) => t.applicationId) } },
          select: { id: true, languageAssessments: { select: { language: true } } },
        }),
  ]);
  const assessedByApplication = new Map(
    applications.map((a) => [a.id, new Set(a.languageAssessments.map((l) => l.language))]),
  );

  const { count } = await prisma.languageReviewDeferral.createMany({
    data: [
      ...claims.map((c) => ({ personLanguageId: c.id, deferredById: actorPersonId })),
      ...applicants
        .filter((t) => assessedByApplication.get(t.applicationId)?.has(t.language) === false)
        .map((t) => ({
          applicationId: t.applicationId,
          language: t.language,
          deferredById: actorPersonId,
        })),
    ],
    skipDuplicates: true,
  });
  return count;
}

/** A verdict on a member's claim settles it, including one set aside to review later. */
export async function clearMemberReviewLater(personId: string, language: string): Promise<void> {
  await prisma.languageReviewDeferral.deleteMany({
    where: { personLanguage: { personId, language } },
  });
}

/** A verdict on an application's language settles it, including one set aside to review later. */
export async function clearApplicantReviewLater(applicationId: string, language: string): Promise<void> {
  await prisma.languageReviewDeferral.deleteMany({ where: { applicationId, language } });
}

/** The flash after a move: `error` when nothing moved, so a stale page does not report success. */
export function reviewLaterFlash(moved: number, later: boolean): { ok: string } | { error: string } {
  if (moved === 0) {
    return { error: "Nothing was moved. Those rows may already have been assessed or moved." };
  }
  return { ok: later ? `Moved ${moved} to Review later.` : `Moved ${moved} back to the queue.` };
}
