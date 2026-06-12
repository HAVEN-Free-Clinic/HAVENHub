import { notFound } from "next/navigation";
import { requireModuleAccess } from "@/platform/auth/session";
import { PageHeader } from "@/platform/ui/page-header";
import { getCourseForLearner } from "@/modules/learning/services/enrollment";
import { LearningAuthError } from "@/modules/learning/services/errors";
import { ScormPlayer } from "./ScormPlayer";

export default async function LearningCoursePage({
  params,
}: {
  params: Promise<{ courseId: string }>;
}) {
  const person = await requireModuleAccess("learning");
  const { courseId } = await params;

  let course;
  try {
    course = await getCourseForLearner(person.personId, courseId);
  } catch (err) {
    if (err instanceof LearningAuthError) notFound();
    throw err;
  }

  return (
    <>
      <PageHeader title={course.title} description={course.description ?? undefined} />
      <div className="mt-6 space-y-4">
        {course.status === "COMPLETE" && (
          <p className="rounded border border-green-300 bg-green-50 px-3 py-2 text-sm text-green-800">
            You have completed this course.
          </p>
        )}
        {course.scos.length > 0 ? (
          <ScormPlayer courseId={course.id} scos={course.scos} />
        ) : (
          <p className="text-sm text-slate-500">This course has no content uploaded yet. Check back soon.</p>
        )}
      </div>
    </>
  );
}
