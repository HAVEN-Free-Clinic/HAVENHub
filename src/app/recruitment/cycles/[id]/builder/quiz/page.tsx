import { notFound } from "next/navigation";
import { requirePermission } from "@/platform/auth/session";
import { getCycle } from "@/modules/recruitment/services/cycles";
import { addQuizSectionAction, addQuizQuestionAction, setCorrectAnswerAction } from "../actions";

export default async function QuizBuilderPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ error?: string }> }) {
  const { id } = await params;
  const { error } = await searchParams;
  await requirePermission("recruitment.manage_cycles");
  const cycle = await getCycle(id);
  if (!cycle) notFound();
  const quizSections = cycle.sections.filter((s) => s.purpose === "QUIZ");

  return (
    <div className="max-w-3xl space-y-6">
      <h1 className="text-2xl font-semibold tracking-tight">Training quiz: {cycle.title}</h1>
      {error && <p role="alert" className="rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

      {quizSections.map((section) => (
        <section key={section.id} className="rounded border p-4">
          <h2 className="font-medium">{section.title}</h2>
          <ul className="mt-3 space-y-3">
            {section.fields.map((f) => {
              const opts = (f.options as { value: string; label: string }[] | null) ?? [];
              return (
                <li key={f.id} className="text-sm">
                  <p className="font-medium">{f.label}</p>
                  <form action={setCorrectAnswerAction.bind(null, id, f.id)} className="mt-1 flex flex-wrap items-center gap-3">
                    {opts.map((o) => (
                      <label key={o.value} className="flex items-center gap-1">
                        <input type="radio" name="correctValue" value={o.value} defaultChecked={f.correctValue === o.value} />
                        {o.label}
                      </label>
                    ))}
                    <button className="text-xs underline">Save correct answer</button>
                  </form>
                </li>
              );
            })}
            {section.fields.length === 0 && <li className="text-sm text-slate-500">No questions yet.</li>}
          </ul>
          <form action={addQuizQuestionAction.bind(null, id, section.id)} className="mt-4 space-y-2">
            <input name="label" placeholder="Question" className="w-full rounded border px-2 py-1 text-sm" />
            <div className="grid grid-cols-2 gap-2">
              <input name="optionValue" placeholder="value (e.g. a)" className="rounded border px-2 py-1 text-sm" />
              <input name="optionLabel" placeholder="Answer A" className="rounded border px-2 py-1 text-sm" />
              <input name="optionValue" placeholder="value (e.g. b)" className="rounded border px-2 py-1 text-sm" />
              <input name="optionLabel" placeholder="Answer B" className="rounded border px-2 py-1 text-sm" />
            </div>
            <input name="correctValue" placeholder="correct value (e.g. a)" className="w-full rounded border px-2 py-1 text-sm" />
            <button className="rounded-md border px-3 py-1.5 text-sm">Add question</button>
          </form>
        </section>
      ))}

      <form action={addQuizSectionAction.bind(null, id)}>
        <input name="title" placeholder="Quiz section title" className="rounded border px-2 py-1 text-sm" />
        <button className="ml-2 rounded-md bg-slate-900 px-3 py-1.5 text-sm text-white">Add quiz section</button>
      </form>
    </div>
  );
}
