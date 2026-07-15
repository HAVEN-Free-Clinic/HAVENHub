"use server";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requirePersonSession } from "@/platform/auth/session";
import { acceptApplicant, revokeAcceptance, RecruitmentAuthError, AcceptanceError } from "@/modules/recruitment/services/review";
import { createInterview, InterviewError } from "@/modules/recruitment/services/interviews";
import { getPostHogClient } from "@/platform/posthog/posthog-server";

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
  const posthog = getPostHogClient();
  posthog.capture({
    distinctId: person.personId,
    event: "applicant_accepted",
    properties: { cycle_id: cycleId, application_id: applicationId, department_code: departmentCode },
  });
  await posthog.flush();
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
  const posthog = getPostHogClient();
  posthog.capture({
    distinctId: person.personId,
    event: "acceptance_revoked",
    properties: { cycle_id: cycleId, application_id: applicationId, acceptance_id: acceptanceId },
  });
  await posthog.flush();
  revalidatePath(bounce(cycleId, applicationId));
}

export async function scheduleInterviewAction(cycleId: string, applicationId: string, formData: FormData) {
  const person = await requirePersonSession();
  const departmentCode = String(formData.get("departmentCode") ?? "").trim();
  let interviewId: string | undefined;
  try {
    const iv = await createInterview(applicationId, departmentCode, person.personId);
    interviewId = iv.id;
  } catch (err) {
    if (err instanceof RecruitmentAuthError || err instanceof InterviewError) {
      redirect(`/recruitment/cycles/${cycleId}/applicants/${applicationId}?error=${encodeURIComponent(err.message)}`);
    }
    throw err;
  }
  const posthog = getPostHogClient();
  posthog.capture({
    distinctId: person.personId,
    event: "interview_scheduled",
    properties: { cycle_id: cycleId, application_id: applicationId, department_code: departmentCode },
  });
  await posthog.flush();
  redirect(`/recruitment/interviews/${interviewId}`);
}
