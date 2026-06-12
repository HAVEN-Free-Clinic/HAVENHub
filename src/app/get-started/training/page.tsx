import { redirect } from "next/navigation";
import { requirePersonSession } from "@/platform/auth/session";
import { Alert } from "@/platform/ui/alert";
import { getMyTraining } from "@/modules/recruitment/services/training";
import { getOnboardingStatus } from "@/modules/onboarding/services/onboarding";
import { TrainingQuiz } from "@/app/training/training-quiz";
import { OnboardingStepShell } from "../onboarding-step-shell";

export default async function OnboardingTrainingPage() {
  const person = await requirePersonSession();
  const status = await getOnboardingStatus(person.personId);
  if (status.exempt || !status.hasActiveTerm || status.onboarded) redirect("/");
  const task = status.tasks.find((t) => t.key === "training");
  if (!task || task.state === "COMPLETE" || task.state === "NOT_REQUIRED") redirect("/get-started");

  const my = await getMyTraining(person.personId);

  return (
    <OnboardingStepShell
      title="Volunteer training"
      description="Most volunteers attend the live session. Missed it? Take the makeup quiz here to clear training."
      completedCount={status.completedCount}
      totalCount={status.totalCount}
    >
      {!my.cycle ? (
        <Alert tone="info">
          Training for {my.term.name} is not open yet. You will get an email when it is ready.
        </Alert>
      ) : my.locked ? (
        <Alert tone="error">
          Your makeup quiz is locked after {my.maxAttempts} attempts. Contact your recruitment
          director to reset it, or attend a live session.
        </Alert>
      ) : (
        <TrainingQuiz
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
