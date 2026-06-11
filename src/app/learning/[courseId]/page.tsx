import { notFound } from "next/navigation";
import { requireModuleAccess } from "@/platform/auth/session";
import { PageHeader } from "@/platform/ui/page-header";
import { getCourseForLearner } from "@/modules/learning/services/enrollment";
import { LearningAuthError } from "@/modules/learning/services/errors";

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
      <div className="mt-6 max-w-2xl space-y-5">
        {course.status === "COMPLETE" && (
          <p className="rounded border border-green-300 bg-green-50 px-3 py-2 text-sm text-green-800">
            You have completed this course.
          </p>
        )}
        {course.status !== "COMPLETE" && course.entryHref && (
          <p className="rounded border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700">
            Launch the course package to begin.{" "}
            <a className="text-blue-700 underline" href={course.entryHref} target="_blank" rel="noreferrer">
              Open course
            </a>
          </p>
        )}
        {!course.entryHref && (
          <p className="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
            No course package has been uploaded yet. Check back soon.
          </p>
        )}
        <dl className="rounded border border-slate-200 divide-y divide-slate-100 text-sm">
          <div className="flex justify-between px-4 py-2">
            <dt className="text-slate-500">Status</dt>
            <dd className="font-medium capitalize">{course.status.replace("_", " ").toLowerCase()}</dd>
          </div>
          {course.cmi.lessonStatus && (
            <div className="flex justify-between px-4 py-2">
              <dt className="text-slate-500">Lesson status</dt>
              <dd>{course.cmi.lessonStatus}</dd>
            </div>
          )}
          {course.cmi.scoreRaw != null && (
            <div className="flex justify-between px-4 py-2">
              <dt className="text-slate-500">Score</dt>
              <dd>{course.cmi.scoreRaw}</dd>
            </div>
          )}
        </dl>
      </div>
    </>
  );
}
