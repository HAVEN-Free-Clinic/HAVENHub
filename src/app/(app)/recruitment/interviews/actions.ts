"use server";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requirePersonSession } from "@/platform/auth/session";
import { updateInterview, addPanelist, removePanelist, sendInterviewInvite, InterviewError } from "@/modules/recruitment/services/interviews";
import { decideInterview, type InterviewOutcome } from "@/modules/recruitment/services/interview-decisions";
import { RecruitmentAuthError, AcceptanceError } from "@/modules/recruitment/services/review";
import { submitEvaluation } from "@/modules/recruitment/services/evaluations";
import type { Recommendation } from "@prisma/client";

// The interview detail page now lives at /recruitment/interviews/[id] (outside the
// recruitment-staff gate) so panelists can reach it. These actions self-authorize
// at the service layer (panel membership for the evaluation; review scope for the
// management actions), so they never depended on the layout gate.
function detail(interviewId: string, error?: string) {
  return `/recruitment/interviews/${interviewId}${error ? `?error=${encodeURIComponent(error)}` : ""}`;
}
function isDomain(err: unknown) {
  return err instanceof RecruitmentAuthError || err instanceof AcceptanceError || err instanceof InterviewError;
}

export async function scheduleAction(interviewId: string, formData: FormData) {
  const person = await requirePersonSession();
  const rawAt = String(formData.get("scheduledAt") ?? "").trim();
  const scheduledAt = rawAt ? new Date(rawAt) : null;
  const zoomLink = String(formData.get("zoomLink") ?? "").trim() || null;
  const notes = String(formData.get("notes") ?? "").trim() || null;
  try { await updateInterview(interviewId, { scheduledAt, zoomLink, notes }, person.personId); }
  catch (err) { if (isDomain(err)) redirect(detail(interviewId, (err as Error).message)); throw err; }
  revalidatePath(detail(interviewId));
}

export async function addPanelistAction(interviewId: string, formData: FormData) {
  const person = await requirePersonSession();
  const personId = String(formData.get("personId") ?? "").trim();
  const isLead = formData.get("isLead") === "on";
  try { await addPanelist(interviewId, personId, isLead, person.personId); }
  catch (err) { if (isDomain(err)) redirect(detail(interviewId, (err as Error).message)); throw err; }
  revalidatePath(detail(interviewId));
}

export async function removePanelistAction(interviewId: string, panelistId: string) {
  const person = await requirePersonSession();
  try { await removePanelist(panelistId, person.personId); }
  catch (err) { if (isDomain(err)) redirect(detail(interviewId, (err as Error).message)); throw err; }
  revalidatePath(detail(interviewId));
}

export async function sendInviteAction(interviewId: string) {
  const person = await requirePersonSession();
  try { await sendInterviewInvite(interviewId, person.personId); }
  catch (err) { if (isDomain(err)) redirect(detail(interviewId, (err as Error).message)); throw err; }
  revalidatePath(detail(interviewId));
}

export async function decideAction(interviewId: string, formData: FormData) {
  const person = await requirePersonSession();
  const outcome = String(formData.get("outcome") ?? "") as InterviewOutcome;
  const notes = String(formData.get("notes") ?? "").trim() || null;
  if (!(["ACCEPT", "REJECT", "WAITLIST"] as InterviewOutcome[]).includes(outcome)) {
    redirect(detail(interviewId, "Invalid outcome."));
  }
  try { await decideInterview(interviewId, outcome, person.personId, notes); }
  catch (err) { if (isDomain(err)) redirect(detail(interviewId, (err as Error).message)); throw err; }
  revalidatePath(detail(interviewId));
}

export async function submitEvaluationAction(interviewId: string, formData: FormData) {
  const person = await requirePersonSession();
  const recommendation = String(formData.get("recommendation") ?? "") as Recommendation;
  const comments = String(formData.get("comments") ?? "").trim() || null;
  if (!(["STRONG_YES", "YES", "MAYBE", "NO"] as Recommendation[]).includes(recommendation)) {
    redirect(detail(interviewId, "Invalid recommendation."));
  }
  try { await submitEvaluation(interviewId, person.personId, recommendation, comments); }
  catch (err) { if (isDomain(err)) redirect(detail(interviewId, (err as Error).message)); throw err; }
  revalidatePath(detail(interviewId));
}
