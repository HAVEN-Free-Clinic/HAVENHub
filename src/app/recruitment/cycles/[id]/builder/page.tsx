import { notFound } from "next/navigation";
import { getCycle } from "@/modules/recruitment/services/cycles";
import { addSectionAction, addFieldAction, deleteFieldAction, deleteSectionAction } from "./actions";

const FIELD_TYPES = ["SHORT_TEXT","LONG_TEXT","SINGLE_SELECT","MULTI_SELECT","CHECKBOX","EMAIL","PHONE","NUMBER","DATE","FILE","DEPARTMENT_CHOICE"];

export default async function BuilderPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ error?: string }> }) {
  const { id } = await params;
  const { error } = await searchParams;
  const cycle = await getCycle(id);
  if (!cycle) notFound();
  const editable = cycle.status === "DRAFT";

  return (
    <div className="max-w-3xl space-y-6">
      <h1 className="text-2xl font-semibold tracking-tight">Form builder: {cycle.title}</h1>
      {!editable && <p className="rounded border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800">This cycle is {cycle.status}. Only safe edits (labels, help text) are allowed.</p>}
      {error && <p role="alert" className="rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

      {cycle.sections.map((section) => (
        <section key={section.id} className="rounded border p-4">
          <div className="flex items-center justify-between">
            <h2 className="font-medium">{section.title} <span className="text-xs text-slate-500">({section.appliesTo}{section.departmentCode ? ` · ${section.departmentCode}` : ""})</span></h2>
            <form action={deleteSectionAction.bind(null, id, section.id)}><button className="text-xs text-red-600">Delete section</button></form>
          </div>
          <ul className="mt-3 space-y-1 text-sm">
            {section.fields.map((f) => (
              <li key={f.id} className="flex items-center justify-between border-t py-1">
                <span>{f.label} <span className="text-xs text-slate-500">· {f.type}{f.required ? " · required" : ""} · {f.key}</span></span>
                <form action={deleteFieldAction.bind(null, id, f.id)}><button className="text-xs text-red-600">Remove</button></form>
              </li>
            ))}
          </ul>
          <form action={addFieldAction.bind(null, id, section.id)} className="mt-3 flex flex-wrap items-end gap-2 text-sm">
            <input name="label" placeholder="Field label" required className="rounded border px-2 py-1" />
            <select name="type" className="rounded border px-2 py-1">{FIELD_TYPES.map((t) => <option key={t}>{t}</option>)}</select>
            <label className="flex items-center gap-1"><input type="checkbox" name="required" /> required</label>
            <textarea name="options" placeholder="options (one per line)" className="rounded border px-2 py-1" rows={1} />
            <button className="rounded bg-slate-900 px-2 py-1 text-white">Add field</button>
          </form>
        </section>
      ))}

      <form action={addSectionAction.bind(null, id)} className="flex flex-wrap items-end gap-2 rounded border border-dashed p-4 text-sm">
        <input name="title" placeholder="New section title" required className="rounded border px-2 py-1" />
        <select name="appliesTo" className="rounded border px-2 py-1"><option>BOTH</option><option>NEW</option><option>RENEWAL</option></select>
        <input name="departmentCode" placeholder="dept code (supplement)" className="rounded border px-2 py-1" />
        <button className="rounded bg-slate-900 px-2 py-1 text-white">Add section</button>
      </form>
    </div>
  );
}
