import { redirect } from "next/navigation";
import { requirePersonSession } from "@/platform/auth/session";
import { Alert } from "@/platform/ui/alert";
import { getMyTrainingForTerm } from "@/modules/recruitment/services/training";
import { makeupOpensOn } from "@/modules/recruitment/services/makeup-window";
import { getActiveTerm } from "@/platform/terms/active-term";
import { getOnboardingStatus } from "@/modules/onboarding/services/onboarding";
import { formatDateOnly } from "@/platform/dates";
import { getDisplayTimeZone } from "@/platform/dates/resolve";
import { TrainingQuiz } from "@/app/(app)/training/training-quiz";
import { OnboardingStepShell } from "../onboarding-step-shell";

export default async function OnboardingTrainingPage({ searchParams }: { searchParams: Promise<{ track?: string }> }) {
  const person = await requirePersonSession();
  const status = await getOnboardingStatus(person.personId);
  if (status.exempt || !status.hasActiveTerm || status.onboarded) redirect("/");

  const sp = await searchParams;
  const track = sp.track === "director" ? "DIRECTOR" : "VOLUNTEER";
  const liveTerm = await getActiveTerm();
  if (!liveTerm) redirect("/get-started");
  const trainings = await getMyTrainingForTerm(person.personId, liveTerm);
  const my = trainings.find((m) => m.track === track);
  if (!my || my.state === "COMPLETE") redirect("/get-started");
  const zone = await getDisplayTimeZone();

  return (
    <OnboardingStepShell
      title={my.trackLabel}
      description="Most people attend the live session. Missed it? Take the makeup quiz here to clear training."
      completedCount={status.completedCount}
      totalCount={status.totalCount}
    >
      {!my.cycle ? (
        <Alert tone="info">Training for {my.term.name} is not open yet. You will get an email when it is ready.</Alert>
      ) : my.locked ? (
        <Alert tone="error">
          Your makeup quiz is locked after {my.maxAttempts} attempts. Contact your recruitment director to reset it, or attend a live session.
        </Alert>
      ) : !my.makeupOpen ? (
        <Alert tone="info">
          Your in-person training is on {formatDateOnly(my.inPersonTrainingDate, zone)}. Attend the live session and
          your director marks you complete. Missed it? The makeup quiz opens{" "}
          {formatDateOnly(makeupOpensOn(my.inPersonTrainingDate!), zone)}.
        </Alert>
      ) : (
        <TrainingQuiz
          termId={my.term.id}
          track={my.track}
          questions={my.questions}
          passPercent={my.passPercent}
          maxAttempts={my.maxAttempts}
          attemptsUsed={my.attemptsUsed}
          intake={my.intake}
        />
      )}
    </OnboardingStepShell>
  );
}
