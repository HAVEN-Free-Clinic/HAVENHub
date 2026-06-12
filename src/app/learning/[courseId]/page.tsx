import { notFound } from "next/navigation";
import { requireModuleAccess } from "@/platform/auth/session";
import { PageHeader } from "@/platform/ui/page-header";
import { getCourseForLearner } from "@/modules/learning/services/enrollment";
import { LearningAuthError } from "@/modules/learning/services/errors";
import { ScormPlayer } from "./ScormPlayer";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";

export default async function LearningCoursePage({
  params,
  searchParams,
}: {
  params: Promise<{ courseId: string }>;
  searchParams: Promise<{ from?: string }>;
}) {
  const person = await requireModuleAccess("learning");
  const { courseId } = await params;
  const { from } = await searchParams;

  let course;
  try {
    course = await getCourseForLearner(person.personId, courseId);
  } catch (err) {
    if (err instanceof LearningAuthError) notFound();
    throw err;
  }

  return (
    <>
      {from === "onboarding" && (
        <Link
          href="/get-started/learning"
          className="mb-4 inline-flex items-center gap-2 text-[13px] font-semibold text-brand transition-colors hover:underline"
        >
          <ArrowLeft aria-hidden className="h-4 w-4" />
          Back to onboarding
        </Link>
      )}
      <PageHeader title={course.title} description={course.description ?? undefined} />
      <div className="mt-6 space-y-4">
        {course.scos.length > 0 ? (
          <ScormPlayer courseId={course.id} scos={course.scos} />
        ) : (
          <p className="text-sm text-slate-500">This course has no content uploaded yet. Check back soon.</p>
        )}
      </div>
    </>
  );
}
