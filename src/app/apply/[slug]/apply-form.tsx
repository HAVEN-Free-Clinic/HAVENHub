"use client";
import { useMemo, useState } from "react";
import { submitPublicApplication, type SubmitResult } from "./actions";
import { isSectionVisible } from "@/modules/recruitment/engine/visibility";
import { Alert } from "@/platform/ui/alert";
import { Button } from "@/platform/ui/button";
import { Input, Textarea } from "@/platform/ui/input";

type FieldDef = { key: string; label: string; helpText: string | null; type: string; required: boolean; options: { value: string; label: string }[] | null; validation: Record<string, unknown> | null };
type SectionDef = { id: string; title: string; description: string | null; appliesTo: "NEW" | "RENEWAL" | "BOTH"; departmentCode: string | null; fields: FieldDef[] };
type Def = { slug: string; title: string; acceptsRenewals: boolean; departments: string[]; sections: SectionDef[] };

export function ApplyForm({ def }: { def: Def }) {
  const [applicantType, setApplicantType] = useState<"NEW" | "RENEWAL">("NEW");
  const [renewalDept, setRenewalDept] = useState<string>(def.departments[0] ?? "");
  const [deptChoice, setDeptChoice] = useState<string>("");
  const [result, setResult] = useState<SubmitResult | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const selectedDepartmentCodes = useMemo(
    () => applicantType === "RENEWAL" ? (renewalDept ? [renewalDept] : []) : (deptChoice ? [deptChoice] : []),
    [applicantType, renewalDept, deptChoice]
  );
  const visible = useMemo(
    () => def.sections.filter((s) => isSectionVisible({ id: s.id, appliesTo: s.appliesTo, departmentCode: s.departmentCode }, { applicantType, selectedDepartmentCodes })),
    [def.sections, applicantType, selectedDepartmentCodes]
  );

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setSubmitting(true);
    const fd = new FormData(e.currentTarget);
    fd.set("__applicantType", applicantType);
    if (applicantType === "RENEWAL") fd.set("__renewalDepartment", renewalDept);
    const res = await submitPublicApplication(def.slug, fd);
    setResult(res);
    setSubmitting(false);
  }

  if (result?.ok) {
    return <Alert tone="success" className="mt-8">Thanks, your application was received. Check your email for a confirmation.</Alert>;
  }

  return (
    <form onSubmit={onSubmit} className="mt-6 space-y-8">
      {result && !result.ok && <Alert tone="error">{result.message}</Alert>}

      {def.acceptsRenewals && (
        <fieldset className="rounded-xl border p-4">
          <legend className="text-sm font-medium">Are you new or renewing?</legend>
          <label className="mr-4 text-sm"><input type="radio" name="__type_ui" checked={applicantType === "NEW"} onChange={() => setApplicantType("NEW")} /> New applicant</label>
          <label className="text-sm"><input type="radio" name="__type_ui" checked={applicantType === "RENEWAL"} onChange={() => setApplicantType("RENEWAL")} /> Renewing in my current department</label>
          {applicantType === "RENEWAL" && (
            <div className="mt-3 text-sm">Current department:
              <select value={renewalDept} onChange={(e) => setRenewalDept(e.target.value)} className="ml-2 rounded-lg border px-2 py-1">{def.departments.map((d) => <option key={d} value={d}>{d}</option>)}</select>
            </div>
          )}
        </fieldset>
      )}

      {visible.map((section) => (
        <fieldset key={section.id} className="space-y-3">
          <legend className="text-sm font-semibold uppercase tracking-wide text-slate-400">{section.title}</legend>
          {section.description && <p className="text-sm text-slate-500">{section.description}</p>}
          {section.fields.map((f) => (
            <Field key={f.key} f={f} departments={def.departments} fieldError={result && !result.ok ? result.fieldErrors?.[f.key] : undefined}
              onDeptChoice={f.type === "DEPARTMENT_CHOICE" ? setDeptChoice : undefined} />
          ))}
        </fieldset>
      ))}

      <Button type="submit" disabled={submitting}>{submitting ? "Submitting…" : "Submit application"}</Button>
    </form>
  );
}

function Field({ f, departments, fieldError, onDeptChoice }: { f: FieldDef; departments: string[]; fieldError?: string; onDeptChoice?: (v: string) => void }) {
  const label = <span className="block text-sm font-medium">{f.label}{f.required && <span className="text-critical"> *</span>}</span>;
  const help = f.helpText ? <span className="block text-xs text-slate-500">{f.helpText}</span> : null;
  const err = fieldError ? <span className="block text-xs text-critical">{fieldError}</span> : null;
  const common = "mt-1 w-full rounded-lg border px-2 py-1 text-sm";

  let control: React.ReactNode;
  switch (f.type) {
    case "LONG_TEXT": control = <Textarea name={f.key} required={f.required} className="mt-1" rows={4} />; break;
    case "CHECKBOX": control = <input type="checkbox" name={f.key} />; break;
    case "NUMBER": control = <Input type="number" name={f.key} required={f.required} className="mt-1" />; break;
    case "DATE": control = <Input type="date" name={f.key} required={f.required} className="mt-1" />; break;
    case "EMAIL": control = <Input type="email" name={f.key} required={f.required} className="mt-1" />; break;
    case "FILE": {
      const accept = Array.isArray(f.validation?.acceptedTypes) ? (f.validation!.acceptedTypes as string[]).join(",") : undefined;
      control = <input type="file" name={f.key} required={f.required} accept={accept} className={common} />;
      break;
    }
    case "DEPARTMENT_CHOICE":
      control = <select name={f.key} required={f.required} className={common} onChange={(e) => onDeptChoice?.(e.target.value)} defaultValue=""><option value="" disabled>Select…</option>{departments.map((d) => <option key={d} value={d}>{d}</option>)}</select>;
      break;
    case "SINGLE_SELECT":
      control = <select name={f.key} required={f.required} className={common} defaultValue=""><option value="" disabled>Select…</option>{(f.options ?? []).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select>;
      break;
    case "MULTI_SELECT":
      control = <span className="mt-1 flex flex-col gap-1">{(f.options ?? []).map((o) => <label key={o.value} className="text-sm"><input type="checkbox" name={f.key} value={o.value} /> {o.label}</label>)}</span>;
      break;
    default: control = <Input type="text" name={f.key} required={f.required} className="mt-1" />;
  }
  return <label className="block">{label}{help}{control}{err}</label>;
}
