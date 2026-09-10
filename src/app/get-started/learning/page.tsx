import { redirect } from "next/navigation";
import { requirePersonSession } from "@/platform/auth/session";
import { getMyCourses } from "@/modules/learning/services/enrollment";
import { AssignedCourseCard } from "@/modules/learning/components/assigned-course-card";
import { getOnboardingStatus } from "@/modules/onboarding/services/onboarding";
import { OnboardingStepShell } from "../onboarding-step-shell";

export default async function OnboardingLearningPage() {
  const person = await requirePersonSession();
  const status = await getOnboardingStatus(person.personId);
  if (status.exempt || !status.hasActiveTerm || status.onboarded) redirect("/");
  // A COMPLETE learning step still renders: the member may be blocked on another
  // step and want to reopen a finished course, and /learning is no longer
  // reachable to them. Only an absent or not-applicable step has nothing to show.
  const task = status.tasks.find((t) => t.key === "learning");
  if (!task || task.state === "NOT_REQUIRED") redirect("/get-started");

  const courses = await getMyCourses(person.personId);

  return (
    <OnboardingStepShell
      title="Learning modules"
      description="Complete the courses your department assigned to you. Each one opens in the course player; you return to this list when you are done."
      completedCount={status.completedCount}
      totalCount={status.totalCount}
    >
      <div className="space-y-3">
        {courses.map((c) => (
          <AssignedCourseCard key={c.id} course={c} href={`/get-started/learning/${c.id}`} />
        ))}
      </div>
    </OnboardingStepShell>
  );
}
