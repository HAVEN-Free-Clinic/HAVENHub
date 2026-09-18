import { prisma } from "@/platform/db";
import { can } from "@/platform/rbac/engine";
import { queueEmail } from "@/platform/email/send";
import { formatDateOnly } from "@/platform/dates";
import { getDisplayTimeZone } from "@/platform/dates/resolve";
import { applicantFirstName } from "@/platform/person-name";
import { recordAudit } from "@/platform/audit";
import { renderResolvedEmail, resolveCycleEmail } from "../email/render";
import { RecruitmentAuthError, AcceptanceError } from "./review";
import { rosterLanguageStatus } from "./applicant-language";
import { rosterDecision } from "../engine/decision-summary";
import { EMPTY_LANGUAGE_STATUS, isAwaitingLanguageAssessment } from "../engine/applicant-language";

/**
 * The "you are on our waitlist" send.
 *
 * Recruitment asked for it so a waitlisted applicant hears two things on
 * decision day instead of nothing: they are still in consideration (not turned
 * down), and they do not need to come to training. Without the second, people
 * who have no place yet give up a Saturday for a session meant for the
 * volunteers joining this term.
 *
 * Two groups are left out, and both leave-outs are about not contradicting an
 * email the applicant already has or will get:
 *
 * - Anyone the interpreting department waitlisted. Recruitment ruled INTP out by
 *   name: its waitlist is the language-hold cohort, and those applicants are
 *   told to COME to training (services/assessment-holds.ts). The code is named
 *   here, not derived from Department.assessLanguageBeforeAcceptance, because
 *   PATS carries that flag too and was not excluded.
 * - Anyone still awaiting a language evaluation, whatever department holds
 *   them. They are the recipients of that same hold email and are expected on
 *   the training roster (listTrainingRoster's third half), so telling them to
 *   stay home would contradict both.
 *
 * Gated on Release like sendRejections, and for the same reason: the portal
 * only shows "Waitlisted" once decisionsReleasedAt is set, and the accepted
 * applicants should hear before anyone is told they are waiting.
 */

/** Department codes whose waitlist never gets this email. See the block above. */
export const WAITLIST_EMAIL_EXCLUDED_DEPARTMENTS: readonly string[] = Object.freeze(["INTP"]);

type WaitlistCandidate = {
  id: string;
  firstName: string;
  email: string;
  emailedAt: Date | null;
  /** The volunteer-track decision, re-asserted as a precondition on the claim. */
  decision: "PENDING" | "ACCEPT" | "REJECT" | "WAITLIST";
};

/**
 * The cycle's waitlisted applications that this email is for.
 *
 * Starts from rosterDecision, so "waitlisted" means what the Decision column on
 * the roster says it means (no acceptance anywhere, a WAITLIST on the
 * application or on an interview). Then narrows, the same way the rejection
 * send does, to applicants with no interview still undecided: a director-track
 * applicant waitlisted by one department and still pending at another has not
 * been placed on the clinic's waitlist yet.
 */
async function loadWaitlistCandidates(cycleId: string): Promise<WaitlistCandidate[]> {
  const apps = await prisma.application.findMany({
    where: {
      cycleId,
      status: "SUBMITTED",
      withdrawnAt: null,
      OR: [{ decision: "WAITLIST" }, { interviews: { some: { decision: "WAITLIST" } } }],
    },
    select: {
      id: true,
      applicantId: true,
      decision: true,
      departmentChoices: true,
      dualRoleDepartments: true,
      routedDepartmentCode: true,
      renewalDepartment: true,
      languagesClaimed: true,
      waitlistEmailedAt: true,
      applicant: { select: { firstName: true, preferredFirstName: true, email: true } },
      acceptances: { select: { departmentCode: true } },
      interviews: { select: { decision: true, departmentCode: true } },
    },
  });
  const waitlisted = apps.filter(
    (a) =>
      rosterDecision({ acceptances: a.acceptances, applicationDecision: a.decision, interviews: a.interviews }).status ===
        "WAITLIST" && !a.interviews.some((iv) => iv.decision === "PENDING"),
  );
  if (waitlisted.length === 0) return [];

  // The same resolver the roster's Language column and the hold send read, so
  // "still awaiting an evaluation" means one thing across all three.
  const language = await rosterLanguageStatus(waitlisted);
  return waitlisted
    .filter((a) => {
      // Which departments put them on the waitlist: the routed department on
      // the volunteer track, each waitlisting interview on the director track.
      const waitlistedBy = [
        ...(a.decision === "WAITLIST" && a.routedDepartmentCode ? [a.routedDepartmentCode] : []),
        ...a.interviews.filter((iv) => iv.decision === "WAITLIST").map((iv) => iv.departmentCode),
      ];
      if (waitlistedBy.some((code) => WAITLIST_EMAIL_EXCLUDED_DEPARTMENTS.includes(code))) return false;
      return !isAwaitingLanguageAssessment(language.byApplicationId.get(a.id) ?? EMPTY_LANGUAGE_STATUS);
    })
    .map((a) => ({
      id: a.id,
      firstName: applicantFirstName(a.applicant),
      email: a.applicant.email,
      emailedAt: a.waitlistEmailedAt,
      decision: a.decision,
    }));
}

export type WaitlistEmailSummary = {
  /** Waitlisted applicants this email is for. */
  waitlisted: number;
  /** Of those, how many have not been told yet: what Send would send. */
  unnotified: number;
  emailed: number;
  /** False until Release has run, which is the gate on sending at all. */
  released: boolean;
};

export async function waitlistEmailSummary(cycleId: string): Promise<WaitlistEmailSummary> {
  const [candidates, cycle] = await Promise.all([
    loadWaitlistCandidates(cycleId),
    prisma.recruitmentCycle.findUnique({ where: { id: cycleId }, select: { decisionsReleasedAt: true } }),
  ]);
  const emailed = candidates.filter((c) => c.emailedAt !== null).length;
  return {
    waitlisted: candidates.length,
    unnotified: candidates.length - emailed,
    emailed,
    released: cycle?.decisionsReleasedAt != null,
  };
}

/**
 * Email every waitlisted, un-emailed applicant this email is for, once.
 * Idempotent: a second run sends nothing. Requires review_all, like the other
 * cycle-wide sends on the Decisions tab.
 */
export async function sendWaitlistEmails(cycleId: string, actorId: string): Promise<{ sent: number }> {
  if (!(await can(actorId, "recruitment.review_all"))) {
    throw new RecruitmentAuthError("Only SRR can send these.");
  }
  const cycle = await prisma.recruitmentCycle.findUnique({ where: { id: cycleId } });
  if (!cycle) throw new AcceptanceError("Cycle not found.");
  if (cycle.status === "DRAFT" || cycle.status === "ARCHIVED") {
    throw new AcceptanceError("Waitlist emails can only be sent for an open or closed cycle.");
  }
  if (cycle.decisionsReleasedAt == null) {
    throw new AcceptanceError("Release decisions before sending waitlist emails, so accepted applicants hear first.");
  }

  const candidates = await loadWaitlistCandidates(cycleId);
  const sources = await resolveCycleEmail(cycleId, "recruitment.waitlist");
  const zone = await getDisplayTimeZone();
  // Preformatted, and empty when unset, because the template's {{#if}} tests it.
  const trainingDate = cycle.inPersonTrainingDate ? formatDateOnly(cycle.inPersonTrainingDate, zone) : "";

  let sent = 0;
  for (const candidate of candidates) {
    if (candidate.emailedAt) continue;
    const email = renderResolvedEmail(sources, {
      firstName: candidate.firstName || "there",
      cycleTitle: cycle.title,
      trainingDate,
    });
    const claimedByThisRun = await prisma.$transaction(async (tx) => {
      // Re-read acceptances inside the transaction, as sendRejections does: an
      // accept that commits after the read above must not be followed by a
      // "you are on our waitlist" email.
      const accepted = await tx.acceptance.count({ where: { applicationId: candidate.id } });
      if (accepted > 0) return false;
      // Atomic claim. Gating on the decision we read means a concurrent reject,
      // reopen, or withdrawal moves the row and this matches nothing.
      const claimed = await tx.application.updateMany({
        where: { id: candidate.id, waitlistEmailedAt: null, status: "SUBMITTED", decision: candidate.decision },
        data: { waitlistEmailedAt: new Date() },
      });
      if (claimed.count !== 1) return false;
      await queueEmail(tx, { to: candidate.email, subject: email.subject, html: email.html, template: "recruitment.waitlist" });
      return true;
    });
    if (claimedByThisRun) sent += 1;
  }

  await recordAudit({ actorPersonId: actorId, action: "recruitment.send_waitlist_emails", entityType: "RecruitmentCycle", entityId: cycleId, after: { sent } });
  return { sent };
}
