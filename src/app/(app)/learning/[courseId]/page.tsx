import { notFound } from "next/navigation";
import { requireModuleAccess } from "@/platform/auth/session";
import { PageHeader } from "@/platform/ui/page-header";
import { Alert } from "@/platform/ui/alert";
import { prisma } from "@/platform/db";
import { getCourseForLearner } from "@/modules/learning/services/enrollment";
import { getVideoCourseForLearner } from "@/modules/learning/services/video-progress";
import { LearningAuthError, MakeupNotOwedError } from "@/modules/learning/services/errors";
import { ScormPlayer } from "./ScormPlayer";
import { VideoCoursePlayer } from "./VideoCoursePlayer";
import { SetBreadcrumbLeaf } from "@/platform/ui/breadcrumb-context";

export default async function LearningCoursePage({
  params,
}: {
  params: Promise<{ courseId: string }>;
}) {
  const person = await requireModuleAccess("learning");
  const { courseId } = await params;

  const kind = (await prisma.course.findUnique({ where: { id: courseId }, select: { kind: true } }))?.kind;
  if (!kind) notFound();

  if (kind === "VIDEO") {
    let course;
    try {
      course = await getVideoCourseForLearner(person.personId, courseId);
    } catch (err) {
      // Someone who does not owe the makeup gets an explanation, not a 404:
      // they may well have followed a link from a member who does.
      if (err instanceof MakeupNotOwedError) {
        return (
          <>
            <PageHeader title="Online makeup" />
            <Alert tone="info" className="mt-6">
              {err.message}
            </Alert>
          </>
        );
      }
      if (err instanceof LearningAuthError) notFound();
      throw err;
    }
    return (
      <>
        <SetBreadcrumbLeaf label={course.title} />
        <PageHeader title={course.title} description={course.description ?? undefined} />
        <div className="mt-6">
          <VideoCoursePlayer course={course} />
        </div>
      </>
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
    <>
      <SetBreadcrumbLeaf label={course.title} />
      <PageHeader title={course.title} description={course.description ?? undefined} />
      <div className="mt-6 space-y-4">
        {course.scos.length > 0 ? (
          <ScormPlayer courseId={course.id} scos={course.scos} />
        ) : (
          <p className="text-sm text-muted-foreground">This course has no content uploaded yet. Check back soon.</p>
        )}
      </div>
    </>
  );
}
