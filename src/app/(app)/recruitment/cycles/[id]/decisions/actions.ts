"use server";
import { redirect } from "next/navigation";
import { requirePersonSession } from "@/platform/auth/session";
import { releaseDecisions } from "@/modules/recruitment/services/decisions";
import { RecruitmentAuthError, AcceptanceError } from "@/modules/recruitment/services/review";
import { getPostHogClient } from "@/lib/posthog-server";

export async function releaseDecisionsAction(cycleId: string) {
  const person = await requirePersonSession();
  try {
    const res = await releaseDecisions(cycleId, person.personId);
    const posthog = getPostHogClient();
    posthog.capture({
      distinctId: person.personId,
      event: "recruitment_decisions_released",
      properties: { cycle_id: cycleId, sent: res.sent, skipped_conflicted: res.skippedConflicted },
    });
    await posthog.shutdown();
    redirect(`/recruitment/cycles/${cycleId}/decisions?sent=${res.sent}&skipped=${res.skippedConflicted}`);
  } catch (err) {
    if (err instanceof RecruitmentAuthError || err instanceof AcceptanceError) {
      redirect(`/recruitment/cycles/${cycleId}/decisions?error=${encodeURIComponent(err.message)}`);
    }
    throw err;
  }
}
