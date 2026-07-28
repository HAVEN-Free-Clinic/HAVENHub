import { notFound, redirect } from "next/navigation";
import { requirePersonSession } from "@/platform/auth/session";
import { can } from "@/platform/rbac/engine";
import { Alert } from "@/platform/ui/alert";
import { getCourseForLearner } from "@/modules/learning/services/enrollment";
import { LearningAuthError } from "@/modules/learning/services/errors";
import { getOnboardingStatus } from "@/modules/onboarding/services/onboarding";
import { ScormPlayer } from "@/app/(app)/learning/[courseId]/ScormPlayer";
import { OnboardingStepShell } from "../../onboarding-step-shell";

/**
 * The SCORM player for a not-yet-cleared member, rendered in the locked
 * onboarding chrome instead of the app shell. A member who is still blocked
 * must never see the module nav: every tab in it bounces them back to
 * /get-started, which reads as the app breaking rather than as a gate.
 *
 * Authorization is getCourseForLearner (course must be assigned). The
 * learning.access check replaces requireModuleAccess, which would send them to
 * the gated /no-access page.
 */
export default async function OnboardingCoursePage({
  params,
}: {
  params: Promise<{ courseId: string }>;
}) {
  const person = await requirePersonSession();
  const status = await getOnboardingStatus(person.personId);
  // Never a dead end: anyone who does not belong in the flow goes to the hub,
  // where the normal /learning route serves them.
  if (status.exempt || !status.hasActiveTerm || status.onboarded) redirect("/");

  const { courseId } = await params;

  const shell = {
    completedCount: status.completedCount,
    totalCount: status.totalCount,
    backHref: "/get-started/learning",
    backLabel: "Back to courses",
  };

  if (!(await can(person.personId, "learning.access"))) {
    return (
      <OnboardingStepShell title="Learning modules" {...shell}>
        <Alert tone="info">
          Your courses are not available yet. Contact your department director.
        </Alert>
      </OnboardingStepShell>
    );
  }

  let course;
  try {
    course = await getCourseForLearner(person.personId, courseId);
  } catch (err) {
    if (err instanceof LearningAuthError) notFound();
    throw err;
  }

  return (
    <OnboardingStepShell title={course.title} description={course.description ?? undefined} wide {...shell}>
      {course.scos.length > 0 ? (
        <ScormPlayer courseId={course.id} scos={course.scos} />
      ) : (
        <p className="text-sm text-muted-foreground">This course has no content uploaded yet. Check back soon.</p>
      )}
    </OnboardingStepShell>
  );
}
