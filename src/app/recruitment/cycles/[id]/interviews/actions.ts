"use server";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requirePersonSession } from "@/platform/auth/session";
import { updateInterview, addPanelist, removePanelist, sendInterviewInvite, InterviewError } from "@/modules/recruitment/services/interviews";
import { decideInterview, type InterviewOutcome } from "@/modules/recruitment/services/interview-decisions";
import { RecruitmentAuthError, AcceptanceError } from "@/modules/recruitment/services/review";
import { submitEvaluation } from "@/modules/recruitment/services/evaluations";
import type { Recommendation } from "@prisma/client";

function detail(cycleId: string, interviewId: string, error?: string) {
  return `/recruitment/cycles/${cycleId}/interviews/${interviewId}${error ? `?error=${encodeURIComponent(error)}` : ""}`;
}
function isDomain(err: unknown) {
  return err instanceof RecruitmentAuthError || err instanceof AcceptanceError || err instanceof InterviewError;
}

export async function scheduleAction(cycleId: string, interviewId: string, formData: FormData) {
  const person = await requirePersonSession();
  const rawAt = String(formData.get("scheduledAt") ?? "").trim();
  const scheduledAt = rawAt ? new Date(rawAt) : null;
  const zoomLink = String(formData.get("zoomLink") ?? "").trim() || null;
  const notes = String(formData.get("notes") ?? "").trim() || null;
  try { await updateInterview(interviewId, { scheduledAt, zoomLink, notes }, person.personId); }
  catch (err) { if (isDomain(err)) redirect(detail(cycleId, interviewId, (err as Error).message)); throw err; }
  revalidatePath(detail(cycleId, interviewId));
}

export async function addPanelistAction(cycleId: string, interviewId: string, formData: FormData) {
  const person = await requirePersonSession();
  const personId = String(formData.get("personId") ?? "").trim();
  const isLead = formData.get("isLead") === "on";
  try { await addPanelist(interviewId, personId, isLead, person.personId); }
  catch (err) { if (isDomain(err)) redirect(detail(cycleId, interviewId, (err as Error).message)); throw err; }
  revalidatePath(detail(cycleId, interviewId));
}

export async function removePanelistAction(cycleId: string, interviewId: string, panelistId: string) {
  const person = await requirePersonSession();
  try { await removePanelist(panelistId, person.personId); }
  catch (err) { if (isDomain(err)) redirect(detail(cycleId, interviewId, (err as Error).message)); throw err; }
  revalidatePath(detail(cycleId, interviewId));
}

export async function sendInviteAction(cycleId: string, interviewId: string) {
  const person = await requirePersonSession();
  try { await sendInterviewInvite(interviewId, person.personId); }
  catch (err) { if (isDomain(err)) redirect(detail(cycleId, interviewId, (err as Error).message)); throw err; }
  revalidatePath(detail(cycleId, interviewId));
}

export async function decideAction(cycleId: string, interviewId: string, formData: FormData) {
  const person = await requirePersonSession();
  const outcome = String(formData.get("outcome") ?? "") as InterviewOutcome;
  const notes = String(formData.get("notes") ?? "").trim() || null;
  try { await decideInterview(interviewId, outcome, person.personId, notes); }
  catch (err) { if (isDomain(err)) redirect(detail(cycleId, interviewId, (err as Error).message)); throw err; }
  revalidatePath(detail(cycleId, interviewId));
}

export async function submitEvaluationAction(cycleId: string, interviewId: string, formData: FormData) {
  const person = await requirePersonSession();
  const recommendation = String(formData.get("recommendation") ?? "") as Recommendation;
  const comments = String(formData.get("comments") ?? "").trim() || null;
  try { await submitEvaluation(interviewId, person.personId, recommendation, comments); }
  catch (err) { if (isDomain(err)) redirect(detail(cycleId, interviewId, (err as Error).message)); throw err; }
  revalidatePath(detail(cycleId, interviewId));
}
