import type { Interview } from "@prisma/client";
import { prisma } from "@/platform/db";
import { recordAudit } from "@/platform/audit";
import { reviewScope, RecruitmentAuthError, AcceptanceError } from "./review";
import { InterviewError } from "./interviews";

export type InterviewOutcome = "ACCEPT" | "REJECT" | "WAITLIST";

export async function decideInterview(
  interviewId: string,
  outcome: InterviewOutcome,
  deciderId: string,
  notes: string | null
): Promise<Interview> {
  const iv = await prisma.interview.findUnique({ where: { id: interviewId } });
  if (!iv) throw new InterviewError("Interview not found.");
  const scope = await reviewScope(deciderId);
  if (!(scope.all || scope.departmentCodes.includes(iv.departmentCode))) {
    throw new RecruitmentAuthError("You can't decide interviews for that department.");
  }

  const key = { applicationId_departmentCode: { applicationId: iv.applicationId, departmentCode: iv.departmentCode } };
  const updated = await prisma.$transaction(async (tx) => {
    if (outcome === "ACCEPT") {
      // Idempotent: keep an existing acceptance (and its notes) as-is.
      const existing = await tx.acceptance.findUnique({ where: key });
      if (!existing) {
        await tx.acceptance.create({ data: { applicationId: iv.applicationId, departmentCode: iv.departmentCode, approvedById: deciderId, notes } });
      }
    } else {
      // Changing away from ACCEPT removes a not-yet-emailed acceptance so the
      // decision and acceptance never disagree.
      const existing = await tx.acceptance.findUnique({ where: key });
      if (existing?.emailedAt) {
        // The applicant has already been emailed this acceptance. Flipping the
        // decision here would leave the acceptance row intact, so the portal and
        // onboarding keep showing "Accepted" while the interview badge reads
        // REJECT/WAITLIST (issue #77). Rescinding a notified acceptance is a
        // deliberate, separately-authorized action (revokeAcceptance), so block
        // the change rather than diverge silently.
        throw new AcceptanceError("This applicant was already emailed their acceptance. Rescind the acceptance before changing this decision.");
      }
      if (existing) await tx.acceptance.delete({ where: { id: existing.id } });
    }
    return tx.interview.update({
      where: { id: interviewId },
      data: { decision: outcome, decidedById: deciderId, decidedAt: new Date(), notes },
    });
  });
  await recordAudit({ actorPersonId: deciderId, action: "recruitment.interview_decide", entityType: "Interview", entityId: interviewId, after: { decision: outcome } });
  return updated;
}
