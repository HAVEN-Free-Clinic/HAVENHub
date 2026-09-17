import { prisma } from "@/platform/db";
import { can } from "@/platform/rbac/engine";
import { queueEmail } from "@/platform/email/send";
import { formatDateOnly } from "@/platform/dates";
import { getDisplayTimeZone } from "@/platform/dates/resolve";
import { languageLabel } from "@/platform/languages/catalog";
import { renderResolvedEmail, resolveCycleEmail } from "../email/render";
import { RecruitmentAuthError, AcceptanceError } from "./review";
import { rosterLanguageStatus } from "./applicant-language";
import { EMPTY_LANGUAGE_STATUS, isAwaitingLanguageAssessment } from "../engine/applicant-language";

/**
 * The "your language evaluation is still to come" send.
 *
 * Recruitment asked for this because the alternative was worse in both
 * directions: an applicant whose department assesses language before accepting
 * cannot be accepted before the evaluation happens, and rejecting them for a
 * delay the clinic caused is unjust. So on decision day they are WAITLISTED
 * (a hold, not an outcome) and told exactly that, instead of receiving the
 * silence that everyone else's decision would leave them in.
 *
 * The email does three jobs: it says this is not a rejection, it asks which
 * dialect they speak so the right evaluator can be booked, and it tells them
 * they are still expected at training. The training half is not decoration --
 * these people stay on the training roster (see listTrainingRoster's expected
 * half), so the email and the roster have to agree about whether to expect them.
 *
 * Deliberately NOT gated on decisionsReleasedAt, unlike sendRejections. The
 * whole point is that this lands INSTEAD of a decision, on the day the others go
 * out or before it; making it wait for Release would recreate the silence it
 * exists to prevent.
 */

/** One waitlisted applicant still owed a language evaluation. */
type HoldCandidate = {
  id: string;
  firstName: string;
  email: string;
  emailedAt: Date | null;
  /** Their own claimed languages, written out. Never the department's implied
   *  ones: telling someone "we have you down as speaking Spanish" when they
   *  never said so (PATS assesses it regardless of claim) would be a fabrication. */
  languages: string[];
};

async function loadHoldCandidates(cycleId: string): Promise<HoldCandidate[]> {
  const apps = await prisma.application.findMany({
    where: { cycleId, status: "SUBMITTED", withdrawnAt: null, decision: "WAITLIST" },
    select: {
      id: true,
      applicantId: true,
      departmentChoices: true,
      dualRoleDepartments: true,
      routedDepartmentCode: true,
      renewalDepartment: true,
      languagesClaimed: true,
      assessmentHoldEmailedAt: true,
      applicant: { select: { firstName: true, email: true } },
    },
  });
  if (apps.length === 0) return [];
  // The same resolver the roster's Language column reads, so "awaiting
  // assessment" means one thing in the app and in this send.
  const language = await rosterLanguageStatus(apps);
  return apps
    .filter((a) => isAwaitingLanguageAssessment(language.byApplicationId.get(a.id) ?? EMPTY_LANGUAGE_STATUS))
    .map((a) => ({
      id: a.id,
      firstName: a.applicant.firstName,
      email: a.applicant.email,
      emailedAt: a.assessmentHoldEmailedAt,
      languages: a.languagesClaimed.map(languageLabel),
    }));
}

export type AssessmentHoldSummary = {
  /** Waitlisted and still owed an evaluation. */
  onHold: number;
  /** Of those, how many have not been told yet -- what Send would send. */
  unnotified: number;
  emailed: number;
};

export async function assessmentHoldSummary(cycleId: string): Promise<AssessmentHoldSummary> {
  const candidates = await loadHoldCandidates(cycleId);
  const emailed = candidates.filter((c) => c.emailedAt !== null).length;
  return { onHold: candidates.length, unnotified: candidates.length - emailed, emailed };
}

/**
 * Email every waitlisted, un-emailed applicant still owed an evaluation, once.
 * Idempotent: a second run sends nothing. Requires review_all, the permission
 * the other two cycle-wide sends require.
 */
export async function sendAssessmentHolds(cycleId: string, actorId: string): Promise<{ sent: number }> {
  if (!(await can(actorId, "recruitment.review_all"))) {
    throw new RecruitmentAuthError("Only SRR can send these.");
  }
  const cycle = await prisma.recruitmentCycle.findUnique({ where: { id: cycleId } });
  if (!cycle) throw new AcceptanceError("Cycle not found.");
  // The same status gate Release and the rejections send enforce: a DRAFT cycle
  // has not started and an ARCHIVED one is over, and neither should be mailing
  // applicants.
  if (cycle.status === "DRAFT" || cycle.status === "ARCHIVED") {
    throw new AcceptanceError("These can only be sent for an open or closed cycle.");
  }

  const candidates = await loadHoldCandidates(cycleId);
  // Resolved once for the whole cycle, like releaseDecisions and sendRejections.
  const sources = await resolveCycleEmail(cycleId, "recruitment.assessment_hold");
  const zone = await getDisplayTimeZone();
  // Preformatted: the render engine has no date helpers, and an empty string is
  // what the template's {{#if}} tests when a cycle has set no training date.
  const trainingDate = cycle.inPersonTrainingDate ? formatDateOnly(cycle.inPersonTrainingDate, zone) : "";

  let sent = 0;
  for (const candidate of candidates) {
    if (candidate.emailedAt) continue;
    const email = renderResolvedEmail(sources, {
      firstName: candidate.firstName || "there",
      cycleTitle: cycle.title,
      languages: candidate.languages.join(", "),
      trainingDate,
      trainingLocation: cycle.trainingLocation ?? "",
    });
    const claimedByThisRun = await prisma.$transaction(async (tx) => {
      // Atomic claim, mirroring sendRejections. Gating on the decision and status
      // we read closes the gap: a concurrent accept, reject, or reopen moves the
      // row and this claim matches nothing, so nobody is told their evaluation is
      // still coming after someone has already decided them.
      const claimed = await tx.application.updateMany({
        where: { id: candidate.id, assessmentHoldEmailedAt: null, status: "SUBMITTED", decision: "WAITLIST" },
        data: { assessmentHoldEmailedAt: new Date() },
      });
      if (claimed.count !== 1) return false;
      await queueEmail(tx, {
        to: candidate.email,
        subject: email.subject,
        html: email.html,
        template: "recruitment.assessment_hold",
      });
      return true;
    });
    if (claimedByThisRun) sent += 1;
  }
  return { sent };
}
