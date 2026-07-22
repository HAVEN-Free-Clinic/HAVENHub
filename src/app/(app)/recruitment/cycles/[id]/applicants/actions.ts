"use server";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requirePersonSession } from "@/platform/auth/session";
import { captureEvent, GROUP_DEPARTMENT } from "@/platform/posthog/capture";
import { termGroupForCycle } from "@/platform/posthog/groups";
import { RecruitmentAuthError, AcceptanceError, revokeAcceptance } from "@/modules/recruitment/services/review";
import { createInterview, InterviewError } from "@/modules/recruitment/services/interviews";
import { submitCommitteeScore, CommitteeScoreError } from "@/modules/recruitment/services/committee-scoring";
import { routeApplication, decideRoutedApplication, reopenDecision, RoutingError } from "@/modules/recruitment/services/routing";
import { loadReviewApplication, type ReviewApplicationView } from "@/modules/recruitment/services/speed-score";

// Each form on the applicant page carries its own error param so a failure renders
// in the card that produced it. A single shared `error` used to dump routing and
// scoring failures into the Department decision card, far from the button clicked.
function bounce(cycleId: string, applicationId: string, opts?: { error?: string; routeError?: string; scoreError?: string; saved?: string }) {
  const base = `/recruitment/cycles/${cycleId}/applicants/${applicationId}`;
  if (opts?.error) return `${base}?error=${encodeURIComponent(opts.error)}`;
  if (opts?.routeError) return `${base}?routeError=${encodeURIComponent(opts.routeError)}`;
  if (opts?.scoreError) return `${base}?scoreError=${encodeURIComponent(opts.scoreError)}`;
  if (opts?.saved) return `${base}?saved=${encodeURIComponent(opts.saved)}`;
  return base;
}

export async function committeeScoreAction(cycleId: string, applicationId: string, formData: FormData) {
  const person = await requirePersonSession();
  const score = Number(formData.get("score"));
  const comments = String(formData.get("comments") ?? "").trim() || null;
  if (!Number.isInteger(score) || score < 1 || score > 5) {
    redirect(bounce(cycleId, applicationId, { scoreError: "Score must be 1 to 5." }));
  }
  try {
    await submitCommitteeScore(applicationId, person.personId, score, comments);
    await captureEvent({
      distinctId: person.personId,
      event: "application_committee_score_submitted",
      properties: { cycle_id: cycleId, application_id: applicationId, score },
      groups: await termGroupForCycle(cycleId),
    });
  } catch (err) {
    if (err instanceof RecruitmentAuthError || err instanceof CommitteeScoreError) redirect(bounce(cycleId, applicationId, { scoreError: err.message }));
    throw err;
  }
  revalidatePath(bounce(cycleId, applicationId));
}

export async function routeAction(cycleId: string, applicationId: string, formData: FormData) {
  const person = await requirePersonSession();
  const departmentCode = String(formData.get("departmentCode") ?? "").trim();
  try {
    await routeApplication(applicationId, departmentCode, person.personId);
    await captureEvent({
      distinctId: person.personId,
      event: "application_routed",
      properties: { cycle_id: cycleId, application_id: applicationId, department_code: departmentCode },
      groups: await termGroupForCycle(cycleId, { [GROUP_DEPARTMENT]: departmentCode }),
    });
  } catch (err) {
    // AcceptanceError is expected here: re-routing away from a department whose
    // acceptance was already emailed (or has an onboarding contract) is blocked by
    // routeApplication. Surface it as an inline error like its sibling guards
    // instead of letting it escape as an uncaught server-action error, which
    // Next renders as a blank "Server Components render" crash.
    if (err instanceof RecruitmentAuthError || err instanceof RoutingError || err instanceof AcceptanceError) {
      redirect(bounce(cycleId, applicationId, { routeError: err.message }));
    }
    throw err;
  }
  revalidatePath(bounce(cycleId, applicationId));
}

export async function decideRoutedAction(cycleId: string, applicationId: string, formData: FormData) {
  const person = await requirePersonSession();
  const outcome = String(formData.get("outcome") ?? "");
  const notes = String(formData.get("notes") ?? "").trim() || null;
  if (!["ACCEPT", "REJECT", "WAITLIST"].includes(outcome)) {
    redirect(bounce(cycleId, applicationId, { error: "Invalid outcome." }));
  }
  try {
    await decideRoutedApplication(applicationId, outcome as "ACCEPT" | "REJECT" | "WAITLIST", person.personId, notes);
    await captureEvent({
      distinctId: person.personId,
      event: "application_decided",
      properties: { cycle_id: cycleId, application_id: applicationId, outcome },
      groups: await termGroupForCycle(cycleId),
    });
  } catch (err) {
    if (err instanceof RecruitmentAuthError || err instanceof RoutingError || err instanceof AcceptanceError) {
      redirect(bounce(cycleId, applicationId, { error: (err as Error).message }));
    }
    throw err;
  }
  redirect(bounce(cycleId, applicationId, { saved: "decision" }));
}

export async function scheduleInterviewAction(cycleId: string, applicationId: string, formData: FormData) {
  const person = await requirePersonSession();
  const departmentCode = String(formData.get("departmentCode") ?? "").trim();
  try {
    const iv = await createInterview(applicationId, departmentCode, person.personId);
    await captureEvent({
      distinctId: person.personId,
      event: "interview_scheduled",
      properties: { cycle_id: cycleId, application_id: applicationId, department_code: departmentCode, interview_id: iv.id },
      groups: await termGroupForCycle(cycleId, { [GROUP_DEPARTMENT]: departmentCode }),
    });
    redirect(`/recruitment/interviews/${iv.id}`);
  } catch (err) {
    if (err instanceof RecruitmentAuthError || err instanceof InterviewError) {
      redirect(`/recruitment/cycles/${cycleId}/applicants/${applicationId}?error=${encodeURIComponent(err.message)}`);
    }
    throw err;
  }
}

/** Score an application and return a result object (no redirect): the speed-score
 *  modal stays open and advances client-side. Reuses the same validated,
 *  self-score-blocking, audited upsert as the detail-page form. */
export async function speedScoreAction(
  applicationId: string,
  score: number,
  comments: string | null,
): Promise<{ error?: string }> {
  const person = await requirePersonSession();
  if (!Number.isInteger(score) || score < 1 || score > 5) {
    return { error: "Score must be a whole number from 1 to 5." };
  }
  try {
    await submitCommitteeScore(applicationId, person.personId, score, comments && comments.trim() ? comments.trim() : null);
    return {};
  } catch (err) {
    if (err instanceof RecruitmentAuthError || err instanceof CommitteeScoreError) return { error: err.message };
    throw err;
  }
}

/** Load one applicant's condensed view model for the speed-score modal. */
export async function loadReviewApplicationAction(
  applicationId: string,
): Promise<{ view: ReviewApplicationView } | { error: string }> {
  const person = await requirePersonSession();
  return loadReviewApplication(applicationId, person.personId);
}

export async function reopenDecisionAction(cycleId: string, applicationId: string) {
  const person = await requirePersonSession();
  try {
    await reopenDecision(applicationId, person.personId);
  } catch (err) {
    if (err instanceof RecruitmentAuthError || err instanceof RoutingError || err instanceof AcceptanceError) {
      redirect(bounce(cycleId, applicationId, { error: (err as Error).message }));
    }
    throw err;
  }
  redirect(bounce(cycleId, applicationId, { saved: "reopened" }));
}

// Rescind a notified acceptance from the applicant detail page. A routed decision
// taken without an interview has no interview screen, so before this existed the
// "rescind the acceptance first" guards pointed at a control the reviewer could not
// reach from anywhere in the app. revokeAcceptance self-authorizes: only review_all
// may delete an emailed acceptance, and an existing onboarding contract blocks it
// outright (deleting would cascade away signatures, DOB, and the HIPAA cert).
export async function rescindAcceptanceAction(cycleId: string, applicationId: string, acceptanceId: string) {
  const person = await requirePersonSession();
  try {
    await revokeAcceptance(acceptanceId, person.personId);
  } catch (err) {
    if (err instanceof RecruitmentAuthError || err instanceof AcceptanceError) {
      redirect(bounce(cycleId, applicationId, { error: (err as Error).message }));
    }
    throw err;
  }
  redirect(bounce(cycleId, applicationId, { saved: "rescind" }));
}
