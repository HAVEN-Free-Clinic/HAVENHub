"use server";
import { redirect } from "next/navigation";
import { requirePersonSession } from "@/platform/auth/session";
import { releaseDecisions } from "@/modules/recruitment/services/decisions";
import { RecruitmentAuthError, AcceptanceError } from "@/modules/recruitment/services/review";
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
