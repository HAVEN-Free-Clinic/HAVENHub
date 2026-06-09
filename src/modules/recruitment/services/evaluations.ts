import type { Evaluation, Recommendation } from "@prisma/client";
import { prisma } from "@/platform/db";
import { recordAudit } from "@/platform/audit";
import { RecruitmentAuthError } from "./review";

export async function submitEvaluation(
  interviewId: string,
  evaluatorId: string,
  recommendation: Recommendation,
  comments: string | null
): Promise<Evaluation> {
  const panelist = await prisma.interviewPanelist.findUnique({ where: { interviewId_personId: { interviewId, personId: evaluatorId } } });
  if (!panelist) throw new RecruitmentAuthError("You are not on this interview's panel.");
  const ev = await prisma.evaluation.upsert({
    where: { interviewId_evaluatorId: { interviewId, evaluatorId } },
    create: { interviewId, evaluatorId, recommendation, comments: comments },
    update: { recommendation, comments: comments },
  });
  await recordAudit({ actorPersonId: evaluatorId, action: "recruitment.evaluation_submit", entityType: "Evaluation", entityId: ev.id });
  return ev;
}

export async function listEvaluations(interviewId: string) {
  return prisma.evaluation.findMany({
    where: { interviewId },
    include: { evaluator: { select: { id: true, name: true } } },
    orderBy: { createdAt: "asc" },
  });
}
