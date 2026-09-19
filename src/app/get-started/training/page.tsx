import { redirect } from "next/navigation";
import { requirePersonSession } from "@/platform/auth/session";
import { Alert } from "@/platform/ui/alert";
import { getMyTrainingForTerm } from "@/modules/recruitment/services/training";
import { MAKEUP_RETIRED_COPY } from "@/modules/recruitment/makeup-retired";
import { getAccessTerm } from "@/platform/terms/access-term";
import { getOnboardingStatus } from "@/modules/onboarding/services/onboarding";
import { formatDateOnly } from "@/platform/dates";
import { getDisplayTimeZone } from "@/platform/dates/resolve";
import { OnboardingStepShell } from "../onboarding-step-shell";

export default async function OnboardingTrainingPage({ searchParams }: { searchParams: Promise<{ track?: string }> }) {
  const person = await requirePersonSession();
  const status = await getOnboardingStatus(person.personId);
  if (status.exempt || !status.hasActiveTerm || status.onboarded) redirect("/");

  const sp = await searchParams;
  const track = sp.track === "director" ? "DIRECTOR" : "VOLUNTEER";
  // The term they are onboarding onto: for a new member added ahead of the switch that
  // is the next term (getAccessTerm), matching the checklist that sent them here.
  const onboardingTerm = await getAccessTerm(person.personId);
  if (!onboardingTerm) redirect("/get-started");
  const trainings = await getMyTrainingForTerm(person.personId, onboardingTerm);
  const my = trainings.find((m) => m.track === track);
  if (!my || my.state === "COMPLETE") redirect("/get-started");
  const zone = await getDisplayTimeZone();

  return (
    <OnboardingStepShell
      title={my.trackLabel}
      description="Attending the in-person session clears training. Your director marks you complete when you attend."
      completedCount={status.completedCount}
      totalCount={status.totalCount}
    >
      {!my.cycle ? (
        <Alert tone="info">Training for {my.term.name} is not open yet. You will get an email when it is ready.</Alert>
      ) : (
        <div className="space-y-3">
          {my.inPersonTrainingDate && (
            <Alert tone="info">In-person training: {formatDateOnly(my.inPersonTrainingDate, zone)}.</Alert>
          )}
          <Alert tone="info">Missed the session? {MAKEUP_RETIRED_COPY}</Alert>
        </div>
      )}
    </OnboardingStepShell>
  );
}
