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
  // A DRAFT application is not a real submission, so an ACCEPT here must not
  // mint an Acceptance for it (audit3 L1).
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
      // Idempotent AND race-safe: INSERT ... ON CONFLICT DO NOTHING keeps any
      // existing acceptance (and its notes) as-is, so two concurrent ACCEPTs can't
      // 500 on @@unique([applicationId, departmentCode]) -- the earlier
      // findUnique+create left a race window that surfaced a raw P2002 (audit F13).
      await tx.acceptance.createMany({
        data: [{ applicationId: iv.applicationId, departmentCode: iv.departmentCode, approvedById: deciderId, notes }],
        skipDuplicates: true,
      });
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
      // Atomic teardown: the guard above read `existing` earlier in this READ
      // COMMITTED tx, so a concurrent releaseDecisions could stamp emailedAt in the
      // gap. Delete only while still not-emailed; if that removes nothing, the
      // acceptance was emailed concurrently -- abort so we never leave an
      // emailed-but-rejected applicant.
      if (existing) {
        const del = await tx.acceptance.deleteMany({ where: { id: existing.id, emailedAt: null } });
        if (del.count === 0) {
          throw new AcceptanceError("This applicant has already been emailed their acceptance or started onboarding. Rescind the acceptance before changing this decision.");
        }
      }
    }
    // #106: gate the terminal write on the decision we read. Without it, a REJECT
    // whose acceptance-teardown read missed a concurrent ACCEPT (committed after
    // that read, in this READ COMMITTED tx) could still write decision=REJECT over
    // it, leaving a live Acceptance releaseDecisions would email to a rejected
    // applicant. The claim fails when another decide moved the row first.
    const claimed = await tx.interview.updateMany({
      where: { id: interviewId, decision: iv.decision },
      data: {
        decision: outcome,
        decidedById: deciderId,
        decidedAt: new Date(),
        // #105: Interview.notes is a single column shared with the Schedule card.
        // The Decision card's Notes box has no default and posts empty, so writing
        // it unconditionally nulled the department's scheduling notes on every
        // decision. Only write notes when the caller actually sent some.
        ...(notes === null ? {} : { notes }),
      },
    });
    if (claimed.count === 0) {
      throw new InterviewError("This interview was just decided by someone else. Refresh and try again.");
    }
    return tx.interview.findUniqueOrThrow({ where: { id: interviewId } });
  });
  await recordAudit({ actorPersonId: deciderId, action: "recruitment.interview_decide", entityType: "Interview", entityId: interviewId, after: { decision: outcome } });
  return updated;
}
