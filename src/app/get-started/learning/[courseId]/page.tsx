import { notFound, redirect } from "next/navigation";
import { requirePersonSession } from "@/platform/auth/session";
import { can } from "@/platform/rbac/engine";
import { Alert } from "@/platform/ui/alert";
import { prisma } from "@/platform/db";
import { getCourseForLearner } from "@/modules/learning/services/enrollment";
import { getVideoCourseForLearner } from "@/modules/learning/services/video-progress";
import { LearningAuthError, MakeupNotOwedError } from "@/modules/learning/services/errors";
import { getOnboardingStatus } from "@/modules/onboarding/services/onboarding";
import { ScormPlayer } from "@/app/(app)/learning/[courseId]/ScormPlayer";
import { VideoCoursePlayer } from "@/app/(app)/learning/[courseId]/VideoCoursePlayer";
import { OnboardingStepShell } from "../../onboarding-step-shell";

/**
 * The course player for a not-yet-cleared member, rendered in the locked
 * onboarding chrome instead of the app shell. A member who is still blocked
 * must never see the module nav: every tab in it bounces them back to
 * /get-started, which reads as the app breaking rather than as a gate.
 *
 * Authorization is the service's (the course must be assigned, or owed as a
 * training makeup). The learning.access check replaces requireModuleAccess,
 * which would send them to the gated /no-access page. A training makeup course
 * is exempt from that check: it is a training requirement, not an assigned
 * course, and it is reachable from the training step by people whose role
 * grants may not include Learning at all.
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
  const course = await prisma.course.findUnique({ where: { id: courseId }, select: { kind: true, makeupForCycleId: true } });
  if (!course) notFound();

  const shell = {
    completedCount: status.completedCount,
    totalCount: status.totalCount,
    backHref: course.makeupForCycleId ? "/get-started/training" : "/get-started/learning",
    backLabel: course.makeupForCycleId ? "Back to training" : "Back to courses",
  };

  if (!course.makeupForCycleId && !(await can(person.personId, "learning.access"))) {
    return (
      <OnboardingStepShell title="Learning modules" {...shell}>
        <Alert tone="info">Your courses are not available yet. Contact your department director.</Alert>
      </OnboardingStepShell>
    );
  }

  if (course.kind === "VIDEO") {
    let video;
    try {
      video = await getVideoCourseForLearner(person.personId, courseId);
    } catch (err) {
      if (err instanceof MakeupNotOwedError) {
        return (
          <OnboardingStepShell title="Online makeup" {...shell}>
            <Alert tone="info">{err.message}</Alert>
          </OnboardingStepShell>
        );
      }
      if (err instanceof LearningAuthError) notFound();
      throw err;
    }
    return (
      <OnboardingStepShell title={video.title} description={video.description ?? undefined} wide {...shell}>
        <VideoCoursePlayer course={video} />
      </OnboardingStepShell>
    );
  }

  let scorm;
  try {
    scorm = await getCourseForLearner(person.personId, courseId);
  } catch (err) {
    if (err instanceof LearningAuthError) notFound();
    throw err;
  }

  return (
    <OnboardingStepShell title={scorm.title} description={scorm.description ?? undefined} wide {...shell}>
      {scorm.scos.length > 0 ? (
        <ScormPlayer courseId={scorm.id} scos={scorm.scos} />
      ) : (
        <p className="text-sm text-muted-foreground">This course has no content uploaded yet. Check back soon.</p>
      )}
    </OnboardingStepShell>
  );
}
