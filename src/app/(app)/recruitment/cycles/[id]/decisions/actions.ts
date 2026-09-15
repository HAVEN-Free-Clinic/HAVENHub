"use server";
import { redirect } from "next/navigation";
import { requirePersonSession } from "@/platform/auth/session";
import { releaseDecisions, sendRejections } from "@/modules/recruitment/services/decisions";
import { RecruitmentAuthError, AcceptanceError } from "@/modules/recruitment/services/review";
import { DualAppointmentError, requestDualAppointment } from "@/modules/recruitment/services/dual-appointments";
import { captureEvent } from "@/platform/posthog/capture";
import { termGroupForCycle } from "@/platform/posthog/groups";

export async function releaseDecisionsAction(cycleId: string) {
  const person = await requirePersonSession();
  let sent = 0, skipped = 0;
  try {
    const res = await releaseDecisions(cycleId, person.personId);
    sent = res.sent;
    skipped = res.skippedConflicted;
  } catch (err) {
    if (err instanceof RecruitmentAuthError || err instanceof AcceptanceError) {
      redirect(`/recruitment/cycles/${cycleId}/decisions?error=${encodeURIComponent(err.message)}`);
    }
    throw err;
  }
  await captureEvent({
    distinctId: person.personId,
    event: "recruitment_decisions_released",
    properties: { cycle_id: cycleId, sent, skipped_conflicted: skipped },
    groups: await termGroupForCycle(cycleId),
  });
  redirect(`/recruitment/cycles/${cycleId}/decisions?sent=${sent}&skipped=${skipped}`);
}

export async function sendRejectionsAction(cycleId: string) {
  const person = await requirePersonSession();
  let sent = 0;
  try {
    const res = await sendRejections(cycleId, person.personId);
    sent = res.sent;
  } catch (err) {
    if (err instanceof RecruitmentAuthError || err instanceof AcceptanceError) {
      redirect(`/recruitment/cycles/${cycleId}/decisions?error=${encodeURIComponent(err.message)}`);
    }
    throw err;
  }
  await captureEvent({
    distinctId: person.personId,
    event: "recruitment_rejections_sent",
    properties: { cycle_id: cycleId, sent },
    groups: await termGroupForCycle(cycleId),
  });
  redirect(`/recruitment/cycles/${cycleId}/decisions?rejected=${sent}`);
}

/**
 * Settle a conflict by keeping both departments: approve the named one as the
 * application's dual appointment. The acceptance already exists, so this only
 * records the approval that stops the pair counting as a conflict.
 */
export async function keepBothDepartmentsAction(cycleId: string, formData: FormData) {
  const person = await requirePersonSession();
  const applicationId = String(formData.get("applicationId") ?? "");
  const departmentCode = String(formData.get("departmentCode") ?? "");
  try {
    await requestDualAppointment(person.personId, {
      applicationId,
      departmentCode,
      cycleId,
      reason: "Accepted by both departments; kept as a dual appointment from the Decisions page.",
    });
  } catch (err) {
    if (err instanceof DualAppointmentError || err instanceof RecruitmentAuthError) {
      redirect(`/recruitment/cycles/${cycleId}/decisions?error=${encodeURIComponent(err.message)}`);
    }
    throw err;
  }
  await captureEvent({
    distinctId: person.personId,
    event: "dual_appointment_added",
    properties: { cycle_id: cycleId, application_id: applicationId, department_code: departmentCode, from: "decisions_conflict" },
    groups: await termGroupForCycle(cycleId),
  });
  redirect(`/recruitment/cycles/${cycleId}/decisions?ok=${encodeURIComponent(`Kept both departments. ${departmentCode} is now their dual appointment.`)}`);
}
