import Link from "next/link";
import { notFound } from "next/navigation";
import { getCycle } from "@/modules/recruitment/services/cycles";
import { addSectionAction, addFieldAction, deleteFieldAction, deleteSectionAction } from "./actions";
import { SetBreadcrumb } from "@/platform/ui/breadcrumb-context";
import { cycleTrail } from "@/modules/recruitment/breadcrumbs";
import { PageHeader } from "@/platform/ui/page-header";
import { Field, Input, Textarea } from "@/platform/ui/input";
import { Select } from "@/platform/ui/select";
import { Checkbox } from "@/platform/ui/checkbox";
import { Alert } from "@/platform/ui/alert";
import { SubmitButton } from "@/platform/ui/submit-button";
import { ConfirmButton } from "@/platform/ui/confirm-button";

const FIELD_TYPES = ["SHORT_TEXT","LONG_TEXT","SINGLE_SELECT","MULTI_SELECT","CHECKBOX","EMAIL","PHONE","NUMBER","DATE","FILE","DEPARTMENT_CHOICE"];

export default async function BuilderPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ error?: string }> }) {
  const { id } = await params;
  const { error } = await searchParams;
  const cycle = await getCycle(id);
  if (!cycle) notFound();
  const editable = cycle.status === "DRAFT";

  return (
    <div className="max-w-3xl space-y-6">
      <SetBreadcrumb
        trail={cycleTrail({
          cycleId: id,
          cycleTitle: cycle.title,
          section: { label: "Form builder", slug: "builder" },
        })}
      />
      <PageHeader
        title="Form builder"
        description={cycle.title}
        action={
          <Link
            href={`/recruitment/cycles/${id}/builder/quiz`}
            className="text-sm font-medium text-brand hover:text-brand-hover"
          >
            Training quiz →
          </Link>
        }
      />
      {!editable && (
        <Alert tone="warning">
          This cycle is {cycle.status}. Only safe edits (labels, help text) are allowed.
        </Alert>
      )}
      {error && <Alert tone="error">{error}</Alert>}

      {cycle.sections.map((section) => (
        <section key={section.id} className="rounded-lg border border-slate-200 bg-white p-5">
          <div className="flex items-center justify-between gap-4">
            <h2 className="font-medium text-slate-900">
              {section.title}{" "}
              <span className="text-xs font-normal text-slate-400">
                ({section.appliesTo}{section.departmentCode ? ` · ${section.departmentCode}` : ""})
              </span>
            </h2>
            <form action={deleteSectionAction.bind(null, id, section.id)}>
              <ConfirmButton label="Delete section" size="sm" />
            </form>
          </div>
          <ul className="mt-4 divide-y divide-slate-100">
            {section.fields.map((f) => (
              <li key={f.id} className="flex items-center justify-between gap-4 py-2 text-sm">
                <span className="text-slate-700">
                  {f.label}{" "}
                  <span className="text-xs text-slate-400">
                    · {f.type}{f.required ? " · required" : ""} · {f.key}
                  </span>
                </span>
                <form action={deleteFieldAction.bind(null, id, f.id)}>
                  <ConfirmButton label="Remove" size="sm" />
                </form>
              </li>
            ))}
            {section.fields.length === 0 && (
              <li className="py-2 text-sm text-slate-400">No fields yet.</li>
            )}
          </ul>
          <form
            action={addFieldAction.bind(null, id, section.id)}
            className="mt-4 flex flex-wrap items-end gap-3 border-t border-slate-100 pt-4"
          >
            <div className="min-w-[12rem] flex-1">
              <Field label="Field label">
                <Input name="label" required />
              </Field>
            </div>
            <div className="w-44">
              <Field label="Type">
                <Select name="type">
                  {FIELD_TYPES.map((t) => (
                    <option key={t}>{t}</option>
                  ))}
                </Select>
              </Field>
            </div>
            <label className="flex items-center gap-2 py-2 text-sm text-slate-600">
              <Checkbox name="required" /> Required
            </label>
            <div className="min-w-[12rem] flex-1">
              <Field label="Options" hint="One per line.">
                <Textarea name="options" rows={1} />
              </Field>
            </div>
            <SubmitButton size="sm" pendingLabel="Adding…">
              Add field
            </SubmitButton>
          </form>
        </section>
      ))}

      <form
        action={addSectionAction.bind(null, id)}
        className="flex flex-wrap items-end gap-3 rounded-lg border border-dashed border-slate-300 bg-slate-50/60 p-5"
      >
        <div className="min-w-[12rem] flex-1">
          <Field label="New section title">
            <Input name="title" required />
          </Field>
        </div>
        <div className="w-36">
          <Field label="Applies to">
            <Select name="appliesTo">
              <option>BOTH</option>
              <option>NEW</option>
              <option>RENEWAL</option>
            </Select>
          </Field>
        </div>
        <div className="w-44">
          <Field label="Dept code" hint="Supplement only.">
            <Input name="departmentCode" />
          </Field>
        </div>
        <SubmitButton size="sm" variant="outline" pendingLabel="Adding…">
          Add section
        </SubmitButton>
      </form>
    </div>
  );
}
