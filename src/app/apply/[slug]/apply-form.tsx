"use client";
import { useMemo, useState } from "react";
import { submitPublicApplication, type SubmitResult } from "./actions";
import { isSectionVisible } from "@/modules/recruitment/engine/visibility";
import { Alert } from "@/platform/ui/alert";
import { Button } from "@/platform/ui/button";
import { Select } from "@/platform/ui/select";
import { FieldPreview } from "@/modules/recruitment/components/field-preview";

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
        <fieldset className="rounded-xl border border-border bg-surface p-4">
          <legend className="text-sm font-medium">Are you new or renewing?</legend>
          <label className="mr-4 text-sm"><input type="radio" name="__type_ui" checked={applicantType === "NEW"} onChange={() => setApplicantType("NEW")} /> New applicant</label>
          <label className="text-sm"><input type="radio" name="__type_ui" checked={applicantType === "RENEWAL"} onChange={() => setApplicantType("RENEWAL")} /> Renewing in my current department</label>
          {applicantType === "RENEWAL" && (
            <div className="mt-3 flex items-center gap-2 text-sm">
              <span>Current department:</span>
              <Select value={renewalDept} onChange={(e) => setRenewalDept(e.target.value)} className="w-auto">{def.departments.map((d) => <option key={d} value={d}>{d}</option>)}</Select>
            </div>
          )}
        </fieldset>
      )}

      {visible.map((section) => (
        <fieldset key={section.id} className="space-y-3">
          <legend className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">{section.title}</legend>
          {section.description && <p className="text-sm text-muted-foreground">{section.description}</p>}
          {section.fields.map((f) => (
            <FieldPreview key={f.key} f={f} departments={def.departments}
              fieldError={result && !result.ok ? result.fieldErrors?.[f.key] : undefined}
              onDeptChoice={f.type === "DEPARTMENT_CHOICE" ? setDeptChoice : undefined} />
          ))}
        </fieldset>
      ))}

      <Button type="submit" disabled={submitting}>{submitting ? "Submitting…" : "Submit application"}</Button>
    </form>
  );
}
