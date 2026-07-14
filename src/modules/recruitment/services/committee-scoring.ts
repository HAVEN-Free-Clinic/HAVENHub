import type { CommitteeScore } from "@prisma/client";
import { prisma } from "@/platform/db";
import { can } from "@/platform/rbac/engine";
import { recordAudit } from "@/platform/audit";
import { RecruitmentAuthError } from "./review";
import { scoreAverage } from "../engine/scoring";

export class CommitteeScoreError extends Error {
  constructor(message: string) { super(message); this.name = "CommitteeScoreError"; }
}

/** A committee reviewer's 1-5 score for an application (one per reviewer). */
export async function submitCommitteeScore(
  applicationId: string,
  scorerId: string,
  score: number,
  comments: string | null,
): Promise<CommitteeScore> {
  if (!Number.isInteger(score) || score < 1 || score > 5) {
    throw new CommitteeScoreError("Score must be a whole number from 1 to 5.");
  }
  const app = await prisma.application.findUnique({
    where: { id: applicationId },
    select: { status: true, cycle: { select: { track: true } }, applicant: { select: { applicantPersonId: true } } },
  });
  if (!app) throw new CommitteeScoreError("Application not found.");
  if (app.status !== "SUBMITTED") throw new CommitteeScoreError("This application hasn't been submitted yet.");
  if (app.cycle.track !== "VOLUNTEER") throw new CommitteeScoreError("Committee scoring applies to volunteer cycles.");
  // Separation of duties: a signed-in applicant who is also on the committee
  // (e.g. a returning member re-applying) must not score their own application.
  // Mirrors acceptApplicant/decideInterview in review.ts / interview-decisions.ts.
  if (app.applicant.applicantPersonId && app.applicant.applicantPersonId === scorerId) {
    throw new RecruitmentAuthError("You can't score your own application.");
  }
  const authorized = (await can(scorerId, "recruitment.score")) || (await can(scorerId, "recruitment.review_all"));
  if (!authorized) throw new RecruitmentAuthError("You can't score applications.");
  const saved = await prisma.committeeScore.upsert({
    where: { applicationId_scorerId: { applicationId, scorerId } },
    create: { applicationId, scorerId, score, comments },
    update: { score, comments },
  });
  await recordAudit({ actorPersonId: scorerId, action: "recruitment.committee_score", entityType: "CommitteeScore", entityId: saved.id, after: { applicationId, score } });
  return saved;
}

/** Running average + all reviewer scores for an application. */
export async function committeeScoreSummary(
  applicationId: string,
): Promise<{ average: number | null; count: number; scores: CommitteeScore[] }> {
  const scores = await prisma.committeeScore.findMany({ where: { applicationId }, orderBy: { createdAt: "asc" } });
  return { ...scoreAverage(scores.map((s) => s.score)), scores };
}
