/**
 * Applicant self-withdrawal from the application portal.
 *
 * The core rule: withdrawal DECLARES, it does not tear down. It flips
 * Application.status to WITHDRAWN, stamps withdrawnAt, and audits. It never
 * deletes an Acceptance, cancels an Interview, or touches an OnboardingContract.
 *
 * That restraint is load-bearing. revokeAcceptance (services/review.ts) refuses
 * outright to delete an acceptance that has a contract, because
 * OnboardingContract.acceptance is onDelete: Cascade and deleting through it
 * would destroy submitted signatures, DOB, and the HIPAA certificate, and orphan
 * the stored blob. interview-decisions.ts carries the mirror guard. A portal
 * action that reached past those guards could destroy onboarding records from an
 * unauthenticated-adjacent surface. So staff execute any cleanup with the
 * existing guarded tooling; this module only records the applicant's intent.
 *
 * Same shape as recordSelfWithdrawal in platform/offboarding: the subject
 * declares, ops executes.
 */

import { prisma } from "@/platform/db";
import { recordAudit } from "@/platform/audit";
import type { ApplicantIdentity } from "./portal-auth";

export class WithdrawError extends Error {
  constructor(m: string) { super(m); this.name = "WithdrawError"; }
}

export type WithdrawKind = "withdraw" | "decline_offer";

const PROMOTED_MESSAGE =
  "You are already on this term's roster. Use My Info to step back, or contact us.";
const RACED_MESSAGE = "This application has already been updated.";

/**
 * The signed-in applicant's own application for this cycle, or null.
 *
 * Resolution is BY SLUG AND IDENTITY ONLY. No identifier supplied by the request
 * ever selects the record, so a forged form field cannot reach somebody else's
 * application. Mirrors findRow in drafts.ts; identity.email is already lowercased
 * by portal-auth, matching the emailLower column directly.
 */
async function findOwnApplication(slug: string, identity: ApplicantIdentity) {
  const cycle = await prisma.recruitmentCycle.findUnique({
    where: { publicSlug: slug },
    select: { id: true, title: true, status: true, opensAt: true, closesAt: true },
  });
  if (!cycle) return null;
  const applicant = await prisma.applicant.findFirst({
    where: {
      cycleId: cycle.id,
      OR: [
        { emailLower: identity.email },
        ...(identity.personId ? [{ applicantPersonId: identity.personId }] : []),
      ],
    },
    include: {
      applications: {
        include: {
          acceptances: { select: { departmentCode: true, contract: { select: { status: true } } } },
          interviews: { select: { id: true, departmentCode: true, scheduledAt: true } },
        },
      },
    },
  });
  const application = applicant?.applications[0];
  if (!applicant || !application) return null;
  return { cycle, applicant, application };
}

/**
 * Remove the applicant from consideration. Returns which flavour of withdrawal
 * it was, so the caller can word its confirmation correctly.
 *
 * Throws WithdrawError for every refusal (not found, wrong owner, still a draft,
 * already withdrawn, already promoted) so the portal action can render the
 * message without leaking whether the slug or the identity was the mismatch.
 */
export async function withdrawApplication(
  slug: string,
  identity: ApplicantIdentity,
): Promise<{ kind: WithdrawKind }> {
  const row = await findOwnApplication(slug, identity);
  if (!row) throw new WithdrawError("Application not found.");
  const { application } = row;

  if (application.status === "DRAFT") throw new WithdrawError("This application has not been submitted yet.");
  if (application.status === "WITHDRAWN") throw new WithdrawError(RACED_MESSAGE);
  if (application.acceptances.some((a) => a.contract?.status === "PROMOTED")) {
    throw new WithdrawError(PROMOTED_MESSAGE);
  }

  const kind: WithdrawKind = application.acceptances.length > 0 ? "decline_offer" : "withdraw";

  const claimed = await prisma.$transaction(async (tx) => {
    // Re-read the promotion state INSIDE the transaction. The guard above ran
    // before this transaction opened, so a promotion that committed in between
    // would otherwise be withdrawn straight past.
    const promoted = await tx.onboardingContract.count({
      where: { acceptance: { applicationId: application.id }, status: "PROMOTED" },
    });
    if (promoted > 0) throw new WithdrawError(PROMOTED_MESSAGE);

    // Atomic claim on the SUBMITTED precondition, in the style of the draft claim
    // in submissions.ts. A double-click, a retry, or a race against a staff
    // decision loses the claim rather than writing twice, which is what keeps the
    // notification in Task 4 from firing more than once.
    const res = await tx.application.updateMany({
      where: { id: application.id, status: "SUBMITTED" },
      data: { status: "WITHDRAWN", withdrawnAt: new Date() },
    });
    return res.count === 1;
  });
  if (!claimed) throw new WithdrawError(RACED_MESSAGE);

  await recordAudit({
    actorPersonId: identity.personId ?? undefined,
    action: "recruitment.application_withdraw",
    entityType: "Application",
    entityId: application.id,
    after: { kind, self: true },
  });

  return { kind };
}
