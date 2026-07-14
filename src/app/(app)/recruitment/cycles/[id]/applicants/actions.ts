"use server";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requirePersonSession } from "@/platform/auth/session";
import { acceptApplicant, revokeAcceptance, RecruitmentAuthError, AcceptanceError } from "@/modules/recruitment/services/review";
import { createInterview, InterviewError } from "@/modules/recruitment/services/interviews";
import { submitCommitteeScore, CommitteeScoreError } from "@/modules/recruitment/services/committee-scoring";
import { routeApplication, RoutingError } from "@/modules/recruitment/services/routing";

function bounce(cycleId: string, applicationId: string, error?: string) {
  return `/recruitment/cycles/${cycleId}/applicants/${applicationId}${error ? `?error=${encodeURIComponent(error)}` : ""}`;
}

export async function acceptApplicantAction(cycleId: string, applicationId: string, formData: FormData) {
  const person = await requirePersonSession();
  const departmentCode = String(formData.get("departmentCode") ?? "").trim();
  const notes = String(formData.get("notes") ?? "").trim() || null;
  try {
    await acceptApplicant(applicationId, departmentCode, person.personId, notes);
  } catch (err) {
    if (err instanceof RecruitmentAuthError || err instanceof AcceptanceError) redirect(bounce(cycleId, applicationId, err.message));
    throw err;
  }
  revalidatePath(bounce(cycleId, applicationId));
}

export async function revokeAcceptanceAction(cycleId: string, applicationId: string, acceptanceId: string) {
  const person = await requirePersonSession();
  try {
    await revokeAcceptance(acceptanceId, person.personId);
  } catch (err) {
    if (err instanceof RecruitmentAuthError || err instanceof AcceptanceError) redirect(bounce(cycleId, applicationId, err.message));
    throw err;
  }
  revalidatePath(bounce(cycleId, applicationId));
}

export async function committeeScoreAction(cycleId: string, applicationId: string, formData: FormData) {
  const person = await requirePersonSession();
  const score = Number(formData.get("score"));
  const comments = String(formData.get("comments") ?? "").trim() || null;
  if (!Number.isInteger(score) || score < 1 || score > 5) {
    redirect(bounce(cycleId, applicationId, "Score must be 1 to 5."));
  }
  try {
    await submitCommitteeScore(applicationId, person.personId, score, comments);
  } catch (err) {
    if (err instanceof RecruitmentAuthError || err instanceof CommitteeScoreError) redirect(bounce(cycleId, applicationId, err.message));
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
    if (err instanceof RecruitmentAuthError || err instanceof RoutingError) redirect(bounce(cycleId, applicationId, err.message));
    throw err;
  }
  revalidatePath(bounce(cycleId, applicationId));
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
