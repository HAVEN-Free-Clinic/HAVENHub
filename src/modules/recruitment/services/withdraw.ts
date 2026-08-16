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
import { can } from "@/platform/rbac/engine";
import { notify } from "@/platform/notifications/notify";
import { peopleWithAnyPermission } from "@/platform/rbac/holders";
import { departmentDirectorPersonIds } from "@/platform/departments";
import { getSetting } from "@/platform/settings/service";
import { renderEmail } from "@/platform/email/templates/renderEmail";
import { applicantWithdrewContext } from "@/platform/email/templates/recruitment";
import { cleanupFiles } from "./upload";
import { isCycleOpen } from "./cycle-window";
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
          acceptances: { select: { departmentCode: true, emailedAt: true, contract: { select: { status: true } } } },
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
 * Tell the people who would otherwise act on stale information.
 *
 * Deliberately silent for a plain under-review withdrawal: the application falls
 * out of the review queue on its own, and during a live cycle one notification
 * per withdrawal is noise on exactly the population that generates the most of
 * them. Notification is reserved for a held interview slot and a planned roster
 * spot, where a human is about to spend time on somebody who is gone.
 */
async function notifyWithdrawal(input: {
  applicantName: string;
  cycleTitle: string;
  kind: WithdrawKind;
  scheduledDepartmentCodes: string[];
  acceptedDepartmentCodes: string[];
  scheduledInterviewIds: string[];
  actorPersonId: string | null;
}): Promise<void> {
  const declinedOffer = input.kind === "decline_offer";
  const hadScheduledInterview = input.scheduledInterviewIds.length > 0;
  if (!declinedOffer && !hadScheduledInterview) return;

  const recipientIds = new Set<string>();

  if (hadScheduledInterview) {
    const panelists = await prisma.interviewPanelist.findMany({
      where: { interviewId: { in: input.scheduledInterviewIds } },
      select: { personId: true },
    });
    for (const p of panelists) recipientIds.add(p.personId);
  }

  // departmentDirectorPersonIds takes a department id, not a code.
  const codes = [...new Set([...input.scheduledDepartmentCodes, ...input.acceptedDepartmentCodes])];
  if (codes.length > 0) {
    const depts = await prisma.department.findMany({ where: { code: { in: codes } }, select: { id: true } });
    for (const d of depts) {
      for (const id of await departmentDirectorPersonIds(d.id)) recipientIds.add(id);
    }
  }

  if (declinedOffer) {
    for (const p of await peopleWithAnyPermission(["recruitment.review_all"])) recipientIds.add(p.id);
  }

  // Never notify the withdrawing applicant about their own withdrawal: on the
  // renewal path they have a Person and can sit in one of the lists above.
  if (input.actorPersonId) recipientIds.delete(input.actorPersonId);
  if (recipientIds.size === 0) return;

  const baseUrl = await getSetting<string>("app.baseUrl");
  const reviewLink = `${baseUrl}/recruitment`;
  const departments = codes.join(", ");
  const { subject, html } = await renderEmail(
    "recruitment.applicant_withdrew",
    applicantWithdrewContext({
      applicantName: input.applicantName,
      cycleTitle: input.cycleTitle,
      declinedOffer,
      hadScheduledInterview,
      departments,
      reviewLink,
    }),
  );

  const summary = declinedOffer
    ? `${input.applicantName} declined their offer for ${input.cycleTitle}. Their acceptance is still on file.`
    : `${input.applicantName} withdrew from ${input.cycleTitle}${hadScheduledInterview ? " and their interview slot is still held." : "."}`;

  const recipients = await prisma.person.findMany({
    where: { id: { in: [...recipientIds] } },
    select: { id: true, entraObjectId: true, contactEmail: true },
  });
  for (const person of recipients) {
    await notify(prisma, {
      type: "recruitment.applicant_withdrew",
      person,
      email: { subject, html },
      teams: { title: `${input.applicantName} withdrew`, summary, link: reviewLink },
      triggeredById: input.actorPersonId,
    });
  }
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

  // An offer is one the applicant has actually SEEN: the acceptance email went
  // out, or onboarding paperwork reached them. This is the same predicate
  // portal-status.ts uses to choose between the "Withdraw application" and
  // "Decline offer" controls (emailedAcc / onboardingAcc), and the two must
  // agree. A bare Acceptance row means SRR recorded a decision that Release has
  // not sent yet; treating that as an offer told the applicant "we will stop
  // considering you" while mailing every review_all holder that they "declined
  // their offer", about an offer that was never made.
  const kind: WithdrawKind = application.acceptances.some((a) => a.emailedAt != null || a.contract != null)
    ? "decline_offer"
    : "withdraw";

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

  // Only after a won claim, so a lost race cannot send the panel a second
  // cancellation email.
  await notifyWithdrawal({
    applicantName: `${row.applicant.firstName} ${row.applicant.lastName}`.trim(),
    cycleTitle: row.cycle.title,
    kind,
    scheduledDepartmentCodes: application.interviews.filter((iv) => iv.scheduledAt != null).map((iv) => iv.departmentCode),
    acceptedDepartmentCodes: application.acceptances.map((a) => a.departmentCode),
    scheduledInterviewIds: application.interviews.filter((iv) => iv.scheduledAt != null).map((iv) => iv.id),
    actorPersonId: identity.personId,
  });

  return { kind };
}

/**
 * Throw away an unsubmitted draft, including any files uploaded into it.
 *
 * Deletes rather than marking WITHDRAWN, and that is required, not merely
 * tidier: Application carries @@unique([cycleId, applicantId]), so a terminal
 * row would lock the applicant out of a cycle that is still open. Discard at
 * 2pm, change your mind at 3pm, no way back in.
 *
 * Reuses the teardown sweepAbandonedDrafts performs (drafts.ts): collect the
 * stored file keys out of answers, clean up the blobs, then delete the Applicant,
 * which cascades to the draft Application. One Applicant holds exactly one
 * application per cycle (Application.@@unique([cycleId, applicantId]) -- NOT
 * Applicant.@@unique([cycleId, emailLower]), which only dedupes applicant rows
 * by email), so deleting it takes nothing else with it.
 *
 * Only offered while the cycle is open, matching the canContinue gate in
 * portal-status: after close there is nothing left to discard toward, and the
 * stale-draft sweep will collect it anyway.
 */
export async function discardDraft(slug: string, identity: ApplicantIdentity): Promise<void> {
  const row = await findOwnApplication(slug, identity);
  if (!row) throw new WithdrawError("Application not found.");
  const { cycle, applicant, application } = row;
  if (application.status !== "DRAFT") throw new WithdrawError("This application has already been submitted.");
  if (!isCycleOpen(cycle, new Date())) throw new WithdrawError("This cycle is no longer accepting applications.");

  const answers = (application.answers as Record<string, unknown> | null) ?? {};
  const keys: string[] = [];
  for (const v of Object.values(answers)) {
    if (v && typeof v === "object" && "storedName" in (v as object)) {
      keys.push(`recruitment/${cycle.id}/${(v as { storedName: string }).storedName}`);
    }
  }
  await cleanupFiles(keys);
  // Deleting the Applicant cascades to its Application (Application FK is onDelete: Cascade).
  await prisma.applicant.delete({ where: { id: applicant.id } });

  await recordAudit({
    actorPersonId: identity.personId ?? undefined,
    action: "recruitment.draft_discard",
    entityType: "Application",
    entityId: application.id,
    before: { cycleId: cycle.id, files: keys.length },
  });
}

/**
 * Undo a withdrawal. Staff-only: the applicant cannot reverse their own, so a
 * change of heart goes through a human and stays visible.
 *
 * Mirrors reopenDecision in routing.ts, but is narrower: it touches only status
 * and withdrawnAt. Acceptances, interviews, and contracts were never torn down
 * by the withdrawal, so there is nothing to rebuild.
 */
export async function reopenWithdrawnApplication(applicationId: string, actorId: string): Promise<void> {
  if (!(await can(actorId, "recruitment.manage_cycles"))) {
    throw new WithdrawError("You can't reopen withdrawn applications.");
  }
  const res = await prisma.application.updateMany({
    where: { id: applicationId, status: "WITHDRAWN" },
    data: { status: "SUBMITTED", withdrawnAt: null },
  });
  if (res.count !== 1) throw new WithdrawError("This application is not withdrawn.");

  await recordAudit({
    actorPersonId: actorId,
    action: "recruitment.application_withdraw_reopen",
    entityType: "Application",
    entityId: applicationId,
    before: { status: "WITHDRAWN" },
    after: { status: "SUBMITTED" },
  });
}
