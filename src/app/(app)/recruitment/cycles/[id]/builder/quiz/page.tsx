import { notFound } from "next/navigation";
import { requirePermission } from "@/platform/auth/session";
import { getCycle } from "@/modules/recruitment/services/cycles";
import { addQuizSectionAction, addQuizQuestionAction, setCorrectAnswerAction } from "../actions";
import { SetBreadcrumb } from "@/platform/ui/breadcrumb-context";
import { cycleTrail } from "@/modules/recruitment/breadcrumbs";
import { PageHeader } from "@/platform/ui/page-header";
import { Field, Input } from "@/platform/ui/input";
import { Alert } from "@/platform/ui/alert";
import { SubmitButton } from "@/platform/ui/submit-button";

export default async function QuizBuilderPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ error?: string }> }) {
  const { id } = await params;
  const { error } = await searchParams;
  await requirePermission("recruitment.manage_cycles");
  const cycle = await getCycle(id);
  if (!cycle) notFound();
  const quizSections = cycle.sections.filter((s) => s.purpose === "QUIZ");

  return (
    <div className="max-w-3xl space-y-6">
      <SetBreadcrumb
        trail={cycleTrail({
          cycleId: id,
          cycleTitle: cycle.title,
          section: { label: "Form builder", slug: "builder" },
          leaf: "Training quiz",
        })}
      />
      <PageHeader title="Training quiz" description={cycle.title} />
      {error && <Alert tone="error">{error}</Alert>}

      {quizSections.map((section) => (
        <section key={section.id} className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <h2 className="font-medium text-slate-900">{section.title}</h2>
          <ul className="mt-4 space-y-4">
            {section.fields.map((f) => {
              const opts = (f.options as { value: string; label: string }[] | null) ?? [];
              return (
                <li key={f.id} className="border-t border-slate-100 pt-4 first:border-t-0 first:pt-0">
                  <p className="text-sm font-medium text-slate-900">{f.label}</p>
                  <form
                    action={setCorrectAnswerAction.bind(null, id, f.id)}
                    className="mt-2 flex flex-wrap items-center gap-4"
                  >
                    {opts.map((o) => (
                      <label key={o.value} className="flex items-center gap-2 text-sm text-slate-700">
                        <input
                          type="radio"
                          name="correctValue"
                          value={o.value}
                          defaultChecked={f.correctValue === o.value}
                          className="h-4 w-4 accent-brand"
                        />
                        {o.label}
                      </label>
                    ))}
                    <SubmitButton size="sm" variant="outline" pendingLabel="Saving…">
                      Save correct answer
                    </SubmitButton>
                  </form>
                </li>
              );
            })}
            {section.fields.length === 0 && <li className="text-sm text-slate-400">No questions yet.</li>}
          </ul>
          <form
            action={addQuizQuestionAction.bind(null, id, section.id)}
            className="mt-5 space-y-3 border-t border-slate-100 pt-5"
          >
            <Field label="Question">
              <Input name="label" />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Value A" hint="e.g. a">
                <Input name="optionValue" />
              </Field>
              <Field label="Answer A">
                <Input name="optionLabel" />
              </Field>
              <Field label="Value B" hint="e.g. b">
                <Input name="optionValue" />
              </Field>
              <Field label="Answer B">
                <Input name="optionLabel" />
              </Field>
            </div>
            <Field label="Correct value" hint="The value of the right answer, e.g. a.">
              <Input name="correctValue" />
            </Field>
            <SubmitButton size="sm" variant="outline" pendingLabel="Adding…">
              Add question
            </SubmitButton>
          </form>
        </section>
      ))}

      <form action={addQuizSectionAction.bind(null, id)} className="flex flex-wrap items-end gap-3 rounded-2xl border border-dashed border-slate-300 bg-slate-50/60 p-5">
        <div className="min-w-[14rem] flex-1">
          <Field label="Quiz section title">
            <Input name="title" />
          </Field>
        </div>
        <SubmitButton size="sm" pendingLabel="Adding…">
          Add quiz section
        </SubmitButton>
      </form>
    </div>
  );
}
