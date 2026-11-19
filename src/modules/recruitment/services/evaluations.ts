import type { Evaluation } from "@prisma/client";
import { prisma } from "@/platform/db";
import { recordAudit } from "@/platform/audit";
import { RecruitmentAuthError } from "./review";
import { assertMayActOnApplication } from "./review-lock";
import { reviewerIdentity } from "./own-application";
import { isOwnApplication } from "../engine/own-application";

export async function submitEvaluation(
  interviewId: string,
  evaluatorId: string,
  score: number,
  comments: string | null
): Promise<Evaluation> {
  const panelist = await prisma.interviewPanelist.findUnique({ where: { interviewId_personId: { interviewId, personId: evaluatorId } } });
  if (!panelist) throw new RecruitmentAuthError("You are not on this interview's panel.");
  // Separation of duties: an applicant who is also on the panel must not score
  // their own interview (mirrors decideRoutedApplication / decideInterview).
  // Recognised by account link, NetID or address, not the link alone, which is
  // missing when they applied signed out (#889).
  const interview = await prisma.interview.findUnique({
    where: { id: interviewId },
    select: {
      application: {
        select: { cycleId: true, applicantId: true, applicant: { select: { applicantPersonId: true, emailLower: true, netId: true } } },
      },
    },
  });
  if (interview && isOwnApplication(interview.application.applicant, await reviewerIdentity(evaluatorId))) {
    throw new RecruitmentAuthError("You can't evaluate your own interview.");
  }
  // A panelist who applied in this cycle evaluates nobody in it, unless they
  // hold an exception (services/review-lock.ts).
  if (interview) await assertMayActOnApplication(interview.application, evaluatorId, "You can't evaluate your own interview.");
  const ev = await prisma.evaluation.upsert({
    where: { interviewId_evaluatorId: { interviewId, evaluatorId } },
    create: { interviewId, evaluatorId, score, comments },
    update: { score, comments },
  });
  await recordAudit({ actorPersonId: evaluatorId, action: "recruitment.evaluation_submit", entityType: "Evaluation", entityId: ev.id });
  return ev;
}
