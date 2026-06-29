"use server";
import { redirect } from "next/navigation";
import { requirePersonSession } from "@/platform/auth/session";
import { assignSubcommittee, SubcommitteeAssignError } from "@/modules/recruitment/services/subcommittees";
import { RecruitmentAuthError } from "@/modules/recruitment/services/review";

export async function assignSubcommitteeAction(cycleId: string, applicationId: string, formData: FormData) {
  const person = await requirePersonSession();
  const raw = String(formData.get("subcommitteeId") ?? "");
  const subcommitteeId = raw === "" ? null : raw;
  try {
    await assignSubcommittee(applicationId, subcommitteeId, person.personId);
  } catch (err) {
    if (err instanceof RecruitmentAuthError || err instanceof SubcommitteeAssignError) {
      redirect(`/recruitment/cycles/${cycleId}/subcommittees?error=${encodeURIComponent((err as Error).message)}`);
    }
    throw err;
  }
  redirect(`/recruitment/cycles/${cycleId}/subcommittees?saved=1`);
}
