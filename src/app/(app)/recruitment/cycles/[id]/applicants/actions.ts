"use server";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requirePersonSession } from "@/platform/auth/session";
import { captureEvent, GROUP_DEPARTMENT } from "@/platform/posthog/capture";
import { termGroupForCycle } from "@/platform/posthog/groups";
import { RecruitmentAuthError, AcceptanceError, revokeAcceptance, canViewerOpenApplication } from "@/modules/recruitment/services/review";
import { createInterview, InterviewError } from "@/modules/recruitment/services/interviews";
import { submitCommitteeScore, CommitteeScoreError } from "@/modules/recruitment/services/committee-scoring";
import { routeApplication, decideRoutedApplication, returnToRouting, reopenDecision, RoutingError } from "@/modules/recruitment/services/routing";
import { loadReviewApplication, type ReviewApplicationView } from "@/modules/recruitment/services/speed-score";
import { reopenWithdrawnApplication, WithdrawError } from "@/modules/recruitment/services/withdraw";

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
  // RETURN is not a decision: it hands the applicant back to the recruitment
  // lead with the application still PENDING. It shares this action because it
  // shares the form (one outcome picker, one notes box), but it routes to a
  // different service function.
  if (!["ACCEPT", "REJECT", "WAITLIST", "RETURN"].includes(outcome)) {
    redirect(bounce(cycleId, applicationId, { error: "Invalid outcome." }));
  }
  // Set only on a RETURN whose actor can no longer open the application they just
  // returned -- see below. Resolved inside the try but acted on after it, so
  // redirect()'s NEXT_REDIRECT throw is never swallowed by the catch.
  let returnedOutOfView = false;
  try {
    if (outcome === "RETURN") {
      const updated = await returnToRouting(applicationId, person.personId, notes);
      // Returning clears routedDepartmentCode, and on a volunteer cycle that field
      // IS a scope-director's access to the application (canViewApplication, and
      // listApplicantsForReview which mirrors it). So the director succeeds and, in
      // the same instant, loses the page: bouncing them back to the detail page hit
      // its notFound(), and their confirmation was a 404. The recruitment lead sees
      // every application and stays put -- re-routing is their next move and the
      // Routing card is right there.
      returnedOutOfView = !(await canViewerOpenApplication(
        // returnToRouting refuses any cycle that is not VOLUNTEER, so a returned
        // application's track is known without re-reading the cycle.
        { ...updated, cycle: { track: "VOLUNTEER" } },
        person.personId,
      ));
    } else {
      await decideRoutedApplication(applicationId, outcome as "ACCEPT" | "REJECT" | "WAITLIST", person.personId, notes);
    }
    await captureEvent({
      distinctId: person.personId,
      event: outcome === "RETURN" ? "application_returned_to_routing" : "application_decided",
      properties: { cycle_id: cycleId, application_id: applicationId, outcome },
      groups: await termGroupForCycle(cycleId),
    });
  } catch (err) {
    if (err instanceof RecruitmentAuthError || err instanceof RoutingError || err instanceof AcceptanceError) {
      redirect(bounce(cycleId, applicationId, { error: (err as Error).message }));
    }
    throw err;
  }
  // A return is deliberately not "Decision recorded.": it records no decision, it
  // hands the applicant back still PENDING. Both landing pages resolve
  // saved=returned to wording that says so (platform/ui/toast/flash.ts).
  if (returnedOutOfView) {
    redirect(`/recruitment/cycles/${cycleId}/applicants?saved=returned`);
  }
  redirect(bounce(cycleId, applicationId, { saved: outcome === "RETURN" ? "returned" : "decision" }));
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

/** Undo an applicant's self-withdrawal. Gated on recruitment.manage_cycles in
 *  the service, so a reviewer without it gets the refusal message, not a crash. */
export async function reopenWithdrawnAction(cycleId: string, applicationId: string) {
  const person = await requirePersonSession();
  try {
    await reopenWithdrawnApplication(applicationId, person.personId);
    // The inverse of application_withdrawn. Without it a reversed withdrawal still
    // counts as a permanent one in every trend, overstating the withdrawal rate.
    await captureEvent({
      distinctId: person.personId,
      event: "application_withdrawal_reopened",
      properties: { cycle_id: cycleId, application_id: applicationId },
      groups: await termGroupForCycle(cycleId),
    });
  } catch (err) {
    if (err instanceof WithdrawError) {
      redirect(bounce(cycleId, applicationId, { error: err.message }));
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
