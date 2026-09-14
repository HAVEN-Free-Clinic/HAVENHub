import type { AiReview } from "@prisma/client";
import { prisma } from "@/platform/db";
import { can } from "@/platform/rbac/engine";
import { reviewerIdentity } from "./own-application";
import { isOwnApplication } from "../engine/own-application";

/** What a reviewer reads of an AiReview: everything except its row id and
 *  creation time. updatedAt is kept as "when this run was imported". */
export type AiReviewView = Omit<AiReview, "id" | "createdAt">;

/**
 * Who may read AI reviews: recruitment leads (recruitment.review_all), the
 * people who route applicants and already see every committee score by name.
 *
 * Committee scorers are left out on purpose. Reading a model's score before
 * forming your own is anchoring, and the committee-versus-AI gap is only worth
 * reading while the committee's reads stay independent of it. Routed-department
 * directors are left out too: they decide from the committee score of an
 * applicant the lead has already routed.
 */
export async function canViewAiReviews(personId: string): Promise<boolean> {
  return can(personId, "recruitment.review_all");
}

const WITH_OWNER = {
  application: { select: { applicant: { select: { applicantPersonId: true, emailLower: true, netId: true } } } },
} as const;

function toView(r: AiReview): AiReviewView {
  return {
    applicationId: r.applicationId,
    runLabel: r.runLabel,
    score: r.score,
    rank: r.rank,
    merit: r.merit,
    engagement: r.engagement,
    skills: r.skills,
    effort: r.effort,
    reliability: r.reliability,
    firstChoiceDepartmentCode: r.firstChoiceDepartmentCode,
    firstChoiceFit: r.firstChoiceFit,
    bestFitDepartmentCode: r.bestFitDepartmentCode,
    justification: r.justification,
    flags: r.flags,
    overrideNote: r.overrideNote,
    updatedAt: r.updatedAt,
  };
}

/**
 * A cycle's AI reviews keyed by application id, for a viewer allowed to read
 * them. Empty for anyone else, so a page can call it without its own gate and
 * still leak nothing. Never includes the viewer's own application, matching how
 * listApplicantsForReview strips a reviewer's own committee scores.
 */
export async function aiReviewsForCycle(cycleId: string, viewerId: string): Promise<Map<string, AiReviewView>> {
  if (!(await canViewAiReviews(viewerId))) return new Map();
  const [rows, me] = await Promise.all([
    prisma.aiReview.findMany({ where: { application: { cycleId } }, include: WITH_OWNER }),
    reviewerIdentity(viewerId),
  ]);
  const out = new Map<string, AiReviewView>();
  for (const r of rows) {
    if (isOwnApplication(r.application.applicant, me)) continue;
    out.set(r.applicationId, toView(r));
  }
  return out;
}

/** One application's AI review, under the same rules as aiReviewsForCycle. */
export async function aiReviewForApplication(applicationId: string, viewerId: string): Promise<AiReviewView | null> {
  if (!(await canViewAiReviews(viewerId))) return null;
  const r = await prisma.aiReview.findUnique({ where: { applicationId }, include: WITH_OWNER });
  if (!r) return null;
  if (isOwnApplication(r.application.applicant, await reviewerIdentity(viewerId))) return null;
  return toView(r);
}
