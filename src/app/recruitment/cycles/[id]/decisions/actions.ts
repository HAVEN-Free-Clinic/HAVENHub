"use server";
import { redirect } from "next/navigation";
import { requirePersonSession } from "@/platform/auth/session";
import { releaseDecisions } from "@/modules/recruitment/services/decisions";
import { RecruitmentAuthError, AcceptanceError } from "@/modules/recruitment/services/review";

export async function releaseDecisionsAction(cycleId: string) {
  const person = await requirePersonSession();
  try {
    const res = await releaseDecisions(cycleId, person.personId);
    redirect(`/recruitment/cycles/${cycleId}/decisions?sent=${res.sent}&skipped=${res.skippedConflicted}`);
  } catch (err) {
    if (err instanceof RecruitmentAuthError || err instanceof AcceptanceError) {
      redirect(`/recruitment/cycles/${cycleId}/decisions?error=${encodeURIComponent(err.message)}`);
    }
    throw err;
  }
}
