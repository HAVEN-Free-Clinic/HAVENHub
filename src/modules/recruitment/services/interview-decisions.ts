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
  const iv = await prisma.interview.findUnique({
    where: { id: interviewId },
    include: { application: { select: { status: true, applicant: { select: { applicantPersonId: true } } } } },
  });
  if (!iv) throw new InterviewError("Interview not found.");
  // Mirror acceptApplicant (review.ts): never turn a DRAFT application into an
  // acceptance. A DRAFT application is not a real submission, so an ACCEPT here
  // must not mint an Acceptance for it (audit3 L1).
  if (iv.application.status !== "SUBMITTED") throw new InterviewError("This application hasn't been submitted yet.");
  // Separation of duties: a signed-in incumbent (e.g. a director re-applying into a
  // department they manage) must not decide their own interview.
  if (iv.application.applicant.applicantPersonId && iv.application.applicant.applicantPersonId === deciderId) {
    throw new RecruitmentAuthError("You can't decide your own interview.");
  }
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
      // Changing away from ACCEPT removes a not-yet-acted-on acceptance so the
      // decision and acceptance never disagree.
      const existing = await tx.acceptance.findUnique({ where: key, include: { contract: { select: { id: true } } } });
      if (existing?.emailedAt || existing?.contract) {
        // The acceptance has already been acted on downstream: either emailed to
        // the applicant (issue #77: flipping would leave the portal/onboarding
        // showing "Accepted" while the badge reads REJECT/WAITLIST), or an
        // onboarding contract has been created. OnboardingContract.acceptance is
        // onDelete: Cascade, so deleting the acceptance here would silently destroy
        // a submitted or promoted onboarding record (signatures and all). Rescinding
        // a live acceptance is a deliberate, separately-authorized action
        // (revokeAcceptance), so block the change rather than lose data silently.
        throw new AcceptanceError("This applicant has already been emailed their acceptance or started onboarding. Rescind the acceptance before changing this decision.");
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
