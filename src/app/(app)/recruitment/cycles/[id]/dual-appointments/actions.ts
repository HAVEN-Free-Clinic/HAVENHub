"use server";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requirePersonSession } from "@/platform/auth/session";
import { captureEvent } from "@/platform/posthog/capture";
import { termGroupForCycle } from "@/platform/posthog/groups";
import { RecruitmentAuthError } from "@/modules/recruitment/services/review";
import {
  DualAppointmentError,
  approveDualAppointment,
  cancelDualAppointment,
  declineDualAppointment,
  dualAppointmentsPath,
  findApplicationByEmailOrNetId,
  requestDualAppointment,
  type RosterOutcome,
} from "@/modules/recruitment/services/dual-appointments";

function bounce(cycleId: string, params: { ok?: string; error?: string }): string {
  const q = new URLSearchParams();
  if (params.ok) q.set("ok", params.ok);
  if (params.error) q.set("error", params.error);
  const qs = q.toString();
  return qs ? `${dualAppointmentsPath(cycleId)}?${qs}` : dualAppointmentsPath(cycleId);
}

/** What approving did to the roster, as the sentence the toast shows. */
function approvedMessage(roster: RosterOutcome | null): string {
  switch (roster) {
    case "added":
      return "Dual appointment approved, and they are on the second roster now.";
    case "failed":
      return "Dual appointment approved, but they could not be added to the second roster. Add them from the term roster.";
    default:
      return "Dual appointment approved. Release sends one acceptance email naming both departments, and promoting their one onboarding form puts them on both rosters.";
  }
}

function isRefusal(err: unknown): err is Error {
  return err instanceof DualAppointmentError || err instanceof RecruitmentAuthError;
}

/**
 * A director's request, or a recruitment manager's add. The volunteer comes
 * from the manager's picker or a suggestion row (applicationId), or, for a
 * director asking for someone not suggested, an exact email or NetID.
 */
export async function requestDualAppointmentAction(cycleId: string, formData: FormData) {
  const person = await requirePersonSession();
  const departmentCode = String(formData.get("departmentCode") ?? "").trim();
  const reason = String(formData.get("reason") ?? "");
  const identifier = String(formData.get("identifier") ?? "").trim();
  let applicationId = String(formData.get("applicationId") ?? "").trim();
  let result: Awaited<ReturnType<typeof requestDualAppointment>>;
  try {
    if (!applicationId && identifier) {
      const found = await findApplicationByEmailOrNetId(cycleId, identifier);
      if (!found) throw new DualAppointmentError("No active application in this cycle matches that email or NetID.");
      applicationId = found.id;
    }
    if (!applicationId) throw new DualAppointmentError("Choose a volunteer.");
    if (!departmentCode) throw new DualAppointmentError("Choose a department.");
    result = await requestDualAppointment(person.personId, { applicationId, departmentCode, reason, cycleId });
  } catch (err) {
    if (isRefusal(err)) redirect(bounce(cycleId, { error: err.message }));
    throw err;
  }
  await captureEvent({
    distinctId: person.personId,
    event: result.status === "APPROVED" ? "dual_appointment_added" : "dual_appointment_requested",
    properties: { cycle_id: cycleId, application_id: applicationId, department_code: departmentCode, roster: result.roster },
    groups: await termGroupForCycle(cycleId),
  });
  revalidatePath(dualAppointmentsPath(cycleId));
  redirect(
    bounce(cycleId, {
      ok: result.status === "PENDING"
        ? "Request sent. A recruitment manager will approve or decline it."
        : approvedMessage(result.roster),
    }),
  );
}

export async function approveDualAppointmentAction(cycleId: string, formData: FormData) {
  const person = await requirePersonSession();
  const id = String(formData.get("id") ?? "");
  let roster: RosterOutcome;
  try {
    ({ roster } = await approveDualAppointment(person.personId, id, String(formData.get("note") ?? "")));
  } catch (err) {
    if (isRefusal(err)) redirect(bounce(cycleId, { error: err.message }));
    throw err;
  }
  await captureEvent({
    distinctId: person.personId,
    event: "dual_appointment_decided",
    properties: { cycle_id: cycleId, dual_appointment_id: id, outcome: "approved", roster },
    groups: await termGroupForCycle(cycleId),
  });
  revalidatePath(dualAppointmentsPath(cycleId));
  redirect(bounce(cycleId, { ok: approvedMessage(roster) }));
}

export async function declineDualAppointmentAction(cycleId: string, formData: FormData) {
  const person = await requirePersonSession();
  const id = String(formData.get("id") ?? "");
  try {
    await declineDualAppointment(person.personId, id, String(formData.get("note") ?? ""));
  } catch (err) {
    if (isRefusal(err)) redirect(bounce(cycleId, { error: err.message }));
    throw err;
  }
  await captureEvent({
    distinctId: person.personId,
    event: "dual_appointment_decided",
    properties: { cycle_id: cycleId, dual_appointment_id: id, outcome: "declined" },
    groups: await termGroupForCycle(cycleId),
  });
  revalidatePath(dualAppointmentsPath(cycleId));
  redirect(bounce(cycleId, { ok: "Request declined." }));
}

export async function cancelDualAppointmentAction(cycleId: string, formData: FormData) {
  const person = await requirePersonSession();
  const id = String(formData.get("id") ?? "");
  try {
    await cancelDualAppointment(person.personId, id, String(formData.get("note") ?? ""));
  } catch (err) {
    if (isRefusal(err)) redirect(bounce(cycleId, { error: err.message }));
    throw err;
  }
  await captureEvent({
    distinctId: person.personId,
    event: "dual_appointment_decided",
    properties: { cycle_id: cycleId, dual_appointment_id: id, outcome: "cancelled" },
    groups: await termGroupForCycle(cycleId),
  });
  revalidatePath(dualAppointmentsPath(cycleId));
  redirect(bounce(cycleId, { ok: "Dual appointment cancelled." }));
}
