"use server";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requirePersonSession } from "@/platform/auth/session";
import { RecruitmentAuthError, AcceptanceError } from "@/modules/recruitment/services/review";
import { createInterview, InterviewError } from "@/modules/recruitment/services/interviews";
import { submitCommitteeScore, CommitteeScoreError } from "@/modules/recruitment/services/committee-scoring";
import { routeApplication, decideRoutedApplication, RoutingError } from "@/modules/recruitment/services/routing";
import { loadReviewApplication, type ReviewApplicationView } from "@/modules/recruitment/services/speed-score";

function bounce(cycleId: string, applicationId: string, opts?: { error?: string; saved?: string }) {
  const base = `/recruitment/cycles/${cycleId}/applicants/${applicationId}`;
  if (opts?.error) return `${base}?error=${encodeURIComponent(opts.error)}`;
  if (opts?.saved) return `${base}?saved=${encodeURIComponent(opts.saved)}`;
  return base;
}

export async function committeeScoreAction(cycleId: string, applicationId: string, formData: FormData) {
  const person = await requirePersonSession();
  const score = Number(formData.get("score"));
  const comments = String(formData.get("comments") ?? "").trim() || null;
  if (!Number.isInteger(score) || score < 1 || score > 5) {
    redirect(bounce(cycleId, applicationId, { error: "Score must be 1 to 5." }));
  }
  try {
    await submitCommitteeScore(applicationId, person.personId, score, comments);
  } catch (err) {
    if (err instanceof RecruitmentAuthError || err instanceof CommitteeScoreError) redirect(bounce(cycleId, applicationId, { error: err.message }));
    throw err;
  }
  revalidatePath(bounce(cycleId, applicationId));
}

export async function routeAction(cycleId: string, applicationId: string, formData: FormData) {
  const person = await requirePersonSession();
  const departmentCode = String(formData.get("departmentCode") ?? "").trim();
  try {
    await routeApplication(applicationId, departmentCode, person.personId);
  } catch (err) {
    if (err instanceof RecruitmentAuthError || err instanceof RoutingError) redirect(bounce(cycleId, applicationId, { error: err.message }));
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
