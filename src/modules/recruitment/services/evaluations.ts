import type { Evaluation } from "@prisma/client";
import { prisma } from "@/platform/db";
import { recordAudit } from "@/platform/audit";
import { RecruitmentAuthError } from "./review";

export async function submitEvaluation(
  interviewId: string,
  evaluatorId: string,
  score: number,
  comments: string | null
): Promise<Evaluation> {
  const panelist = await prisma.interviewPanelist.findUnique({ where: { interviewId_personId: { interviewId, personId: evaluatorId } } });
  if (!panelist) throw new RecruitmentAuthError("You are not on this interview's panel.");
  // Separation of duties: a signed-in applicant who is also on the panel must not
  // score their own interview (mirrors decideRoutedApplication / decideInterview).
  const interview = await prisma.interview.findUnique({
    where: { id: interviewId },
    select: { application: { select: { applicant: { select: { applicantPersonId: true } } } } },
  });
  const applicantPersonId = interview?.application.applicant.applicantPersonId ?? null;
  if (applicantPersonId && applicantPersonId === evaluatorId) {
    throw new RecruitmentAuthError("You can't evaluate your own interview.");
  }
  const ev = await prisma.evaluation.upsert({
    where: { interviewId_evaluatorId: { interviewId, evaluatorId } },
    create: { interviewId, evaluatorId, score, comments },
    update: { score, comments },
  });
  await recordAudit({ actorPersonId: evaluatorId, action: "recruitment.evaluation_submit", entityType: "Evaluation", entityId: ev.id });
  return ev;
}
