import { redirect } from "next/navigation";
import Link from "next/link";
import { requirePersonSession } from "@/platform/auth/session";
import { Card } from "@/platform/ui/card";
import { Badge } from "@/platform/ui/badge";
import { getMyCourses } from "@/modules/learning/services/enrollment";
import { getOnboardingStatus } from "@/modules/onboarding/services/onboarding";
import { OnboardingStepShell } from "../onboarding-step-shell";

const LABEL = { COMPLETE: "Complete", IN_PROGRESS: "In progress", NOT_STARTED: "Not started" } as const;

export default async function OnboardingLearningPage() {
  const person = await requirePersonSession();
  const status = await getOnboardingStatus(person.personId);
  if (status.exempt || !status.hasActiveTerm || status.onboarded) redirect("/");
  const task = status.tasks.find((t) => t.key === "learning");
  if (!task || task.state === "COMPLETE" || task.state === "NOT_REQUIRED") redirect("/get-started");

  const courses = await getMyCourses(person.personId);

  return (
    <OnboardingStepShell
      title="Learning modules"
      description="Complete the courses your department assigned to you. Each one opens here; you return to this list when you are done."
      completedCount={status.completedCount}
      totalCount={status.totalCount}
    >
      <div className="space-y-3">
        {courses.map((c) => (
          <Link key={c.id} href={`/get-started/learning/${c.id}`} className="block">
            <Card interactive>
              <div className="flex items-center justify-between gap-3">
                <span className="font-medium text-foreground">{c.title}</span>
                <Badge tone={c.status === "COMPLETE" ? "success" : "default"}>{LABEL[c.status]}</Badge>
              </div>
              {c.description && <p className="mt-1 text-sm text-muted-foreground">{c.description}</p>}
            </Card>
          </Link>
        ))}
      </div>
    </OnboardingStepShell>
  );
}
