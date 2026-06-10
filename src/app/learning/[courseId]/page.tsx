import { notFound } from "next/navigation";
import { requireModuleAccess } from "@/platform/auth/session";
import { PageHeader } from "@/platform/ui/page-header";
import { getCourseForLearner } from "@/modules/learning/services/enrollment";
import { LearningAuthError } from "@/modules/learning/services/errors";
import { markModuleCompleteAction, submitCourseQuizAction } from "../actions";

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
        {course.modules.map((m, i) => (
          <section key={m.id} className="rounded border border-slate-200 p-4">
            <div className="flex items-center justify-between">
              <h2 className="font-medium">
                {i + 1}. {m.title}
              </h2>
              {(m.kind === "VIDEO" || m.kind === "DOCUMENT") && m.completed && (
                <span className="text-xs text-green-700">Done</span>
              )}
              {m.kind === "QUIZ" && m.quizPassed && <span className="text-xs text-green-700">Passed</span>}
            </div>
            {m.description && <p className="mt-1 text-sm text-slate-500">{m.description}</p>}

            {(m.kind === "VIDEO" || m.kind === "DOCUMENT") && (
              <div className="mt-3 flex items-center gap-3 text-sm">
                {m.url && (
                  <a className="text-blue-700 underline" href={m.url} target="_blank" rel="noreferrer">
                    Open {m.kind === "VIDEO" ? "video" : "document"}
                  </a>
                )}
                {!m.completed && (
                  <form action={markModuleCompleteAction}>
                    <input type="hidden" name="moduleId" value={m.id} />
                    <input type="hidden" name="courseId" value={course.id} />
                    <button className="rounded bg-slate-800 px-3 py-1 text-white" type="submit">
                      Mark complete
                    </button>
                  </form>
                )}
              </div>
            )}

            {m.kind === "QUIZ" && !m.quizPassed && (
              <div className="mt-3 text-sm">
                {m.locked ? (
                  <p className="rounded border border-red-300 bg-red-50 px-3 py-2 text-red-700">
                    This quiz is locked after {m.maxAttempts} attempts. Ask a manager to reset it.
                  </p>
                ) : (
                  <form action={submitCourseQuizAction} className="space-y-4">
                    <input type="hidden" name="moduleId" value={m.id} />
                    <input type="hidden" name="courseId" value={course.id} />
                    <p className="text-slate-500">
                      Need {m.passPercent}% to pass. {m.maxAttempts - m.attemptsUsed} attempt(s) left.
                    </p>
                    {m.questions.map((q) => (
                      <fieldset key={q.key} className="space-y-1">
                        <legend className="font-medium">{q.label}</legend>
                        {q.options.map((opt) => (
                          <label key={opt.value} className="flex items-center gap-2">
                            <input type="radio" name={`q:${q.key}`} value={opt.value} required />
                            {opt.label}
                          </label>
                        ))}
                      </fieldset>
                    ))}
                    <button className="rounded bg-slate-800 px-3 py-1 text-white" type="submit">
                      Submit quiz
                    </button>
                  </form>
                )}
              </div>
            )}
          </section>
        ))}
      </div>
    </>
  );
}
