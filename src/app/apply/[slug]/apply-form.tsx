"use client";
import { useMemo, useState } from "react";
import { submitPublicApplication, type SubmitResult } from "./actions";
import { isSectionVisible } from "@/modules/recruitment/engine/visibility";
import { Alert } from "@/platform/ui/alert";
import { Button, buttonClasses } from "@/platform/ui/button";
import { Select } from "@/platform/ui/select";
import { FieldPreview } from "@/modules/recruitment/components/field-preview";

function cx(...parts: (string | undefined | false | null)[]): string {
  return parts.filter(Boolean).join(" ");
}

const APPLICANT_OPTIONS = [
  { value: "NEW" as const, label: "New applicant", desc: "First time applying to volunteer" },
  { value: "RENEWAL" as const, label: "Returning volunteer", desc: "Renewing in my current department" },
];

type FieldDef = { key: string; label: string; helpText: string | null; type: string; required: boolean; options: { value: string; label: string }[] | null; validation: Record<string, unknown> | null };
type SectionDef = { id: string; title: string; description: string | null; appliesTo: "NEW" | "RENEWAL" | "BOTH"; departmentCode: string | null; fields: FieldDef[] };
type Def = { slug: string; title: string; acceptsRenewals: boolean; departments: string[]; subcommittees: { id: string; name: string }[]; sections: SectionDef[] };
type Prefill = { values: Record<string, string>; lockedKeys: string[] };

export function ApplyForm({
  def, signedIn = false, signedInName = null, eligible = false, prefill, currentDepartments = [], initialApplicantType = "NEW",
}: {
  def: Def;
  signedIn?: boolean;
  signedInName?: string | null;
  eligible?: boolean;
  prefill?: Prefill;
  currentDepartments?: string[];
  initialApplicantType?: "NEW" | "RENEWAL";
}) {
  // A returning visitor whose account has no current membership is moved to the
  // New flow on arrival, with a note.
  const autoIneligible = initialApplicantType === "RENEWAL" && signedIn && !eligible;
  const [applicantType, setApplicantType] = useState<"NEW" | "RENEWAL">(autoIneligible ? "NEW" : initialApplicantType);
  const [ineligibleNote, setIneligibleNote] = useState(autoIneligible);
  const [renewalDept, setRenewalDept] = useState<string>(currentDepartments[0] ?? def.departments[0] ?? "");
  const [deptChoice, setDeptChoice] = useState<string>("");
  const [result, setResult] = useState<SubmitResult | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const lockedKeys = useMemo(() => new Set(prefill?.lockedKeys ?? []), [prefill]);
  const loginHref = `/login?callbackUrl=${encodeURIComponent(`/apply/${def.slug}?type=renewal`)}`;
  const renewalGate = applicantType === "RENEWAL" && !signedIn;

  function chooseType(v: "NEW" | "RENEWAL") {
    if (v === "RENEWAL" && signedIn && !eligible) {
      setApplicantType("NEW");
      setIneligibleNote(true);
      return;
    }
    setIneligibleNote(false);
    setApplicantType(v);
  }

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
        <fieldset className="space-y-3">
          <legend className="text-sm font-medium text-foreground">Are you a new or returning volunteer?</legend>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {APPLICANT_OPTIONS.map((opt) => {
              const active = applicantType === opt.value;
              return (
                <label
                  key={opt.value}
                  className={cx(
                    "flex cursor-pointer items-start gap-3 rounded-xl border px-4 py-3 transition-colors",
                    "[&:has(:focus-visible)]:ring-2 [&:has(:focus-visible)]:ring-brand/30",
                    active ? "border-brand bg-brand-faint" : "border-border-strong hover:bg-muted",
                  )}
                >
                  <input type="radio" name="__type_ui" className="sr-only" checked={active} onChange={() => chooseType(opt.value)} />
                  <span className={cx("mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border", active ? "border-brand" : "border-border-strong")} aria-hidden>
                    {active && <span className="h-2 w-2 rounded-full bg-brand" />}
                  </span>
                  <span>
                    <span className={cx("block text-sm font-medium", active ? "text-brand-fg" : "text-foreground")}>{opt.label}</span>
                    <span className="block text-xs text-muted-foreground">{opt.desc}</span>
                  </span>
                </label>
              );
            })}
          </div>

          {ineligibleNote && (
            <Alert tone="warning">We do not see a current volunteer membership for your account, so we have set you up as a new applicant. Your name and email are filled in below.</Alert>
          )}

          {applicantType === "RENEWAL" && signedIn && eligible && (
            <label className="flex flex-col gap-1.5 pt-1">
              <span className="text-sm font-medium text-foreground">Current department</span>
              <Select value={renewalDept} onChange={(e) => setRenewalDept(e.target.value)} className="sm:max-w-xs">{def.departments.map((d) => <option key={d} value={d}>{d}</option>)}</Select>
            </label>
          )}
        </fieldset>
      )}

      {renewalGate ? (
        <div className="rounded-xl border border-border bg-surface p-5">
          <p className="text-sm text-foreground">Returning volunteers sign in with Yale so we can verify your renewal and fill in your information.</p>
          <a href={loginHref} className={cx(buttonClasses("primary", "md"), "mt-3")}>Sign in with Yale</a>
        </div>
      ) : (
        <>
          {signedIn && applicantType === "RENEWAL" && eligible && signedInName && (
            <p className="text-sm text-muted-foreground">Signed in as {signedInName}.</p>
          )}

          {visible.map((section) => (
            <fieldset key={section.id} className="space-y-3">
              <legend className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">{section.title}</legend>
              {section.description && <p className="text-sm text-muted-foreground">{section.description}</p>}
              {section.fields.map((f) => (
                <FieldPreview key={f.key} f={f} departments={def.departments} subcommittees={def.subcommittees}
                  fieldError={result && !result.ok ? result.fieldErrors?.[f.key] : undefined}
                  onDeptChoice={f.type === "DEPARTMENT_CHOICE" ? setDeptChoice : undefined}
                  prefill={prefill?.values[f.key]} locked={lockedKeys.has(f.key)} />
              ))}
            </fieldset>
          ))}

          <Button type="submit" disabled={submitting}>{submitting ? "Submitting…" : "Submit application"}</Button>
        </>
      )}
    </form>
  );
}
