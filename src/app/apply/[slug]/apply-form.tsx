"use client";
import { useMemo, useRef, useState } from "react";
import { submitPublicApplication, type SubmitResult } from "./actions";
import { saveDraftAction, uploadDraftFileAction } from "./draft-actions";
import { isSectionVisible } from "@/modules/recruitment/engine/visibility";
import { Alert } from "@/platform/ui/alert";
import { Button, buttonClasses } from "@/platform/ui/button";
import { Select } from "@/platform/ui/select";
import { Field, ReadonlyField } from "@/platform/ui/input";
import { Card } from "@/platform/ui/card";
import { FormSection, FormActions } from "@/platform/ui/form";
import { RadioGroup, Radio } from "@/platform/ui/radio";
import { FieldPreview } from "@/modules/recruitment/components/field-preview";
import { prefillString } from "@/modules/recruitment/components/field-prefill";

type FieldDef ={ key: string; label: string; helpText: string | null; type: string; required: boolean; options: { value: string; label: string }[] | null; validation: Record<string, unknown> | null };
type SectionDef = { id: string; title: string; description: string | null; appliesTo: "NEW" | "RENEWAL" | "BOTH"; departmentCode: string | null; fields: FieldDef[] };
type Def = { slug: string; title: string; track: "VOLUNTEER" | "DIRECTOR"; acceptsRenewals: boolean; departments: string[]; subcommittees: { id: string; name: string }[]; sections: SectionDef[] };
type Prefill = { values: Record<string, string>; lockedKeys: string[] };

export function ApplyForm({
  def, signedIn = false, signedInName = null, eligible = false, prefill, currentDepartments = [], initialApplicantType = "NEW",
  initialAnswers = {}, initialApplicantTypeFromDraft, initialRenewalDepartment = null,
}: {
  def: Def;
  signedIn?: boolean;
  signedInName?: string | null;
  eligible?: boolean;
  prefill?: Prefill;
  currentDepartments?: string[];
  initialApplicantType?: "NEW" | "RENEWAL";
  initialAnswers?: Record<string, unknown>;
  initialApplicantTypeFromDraft?: "NEW" | "RENEWAL";
  initialRenewalDepartment?: string | null;
}) {
  // Draft type takes precedence over the URL ?type param when present.
  const seedType = initialApplicantTypeFromDraft ?? initialApplicantType;

  // A returning visitor whose account has no current membership is moved to the
  // New flow on arrival, with a note.
  const autoIneligible = seedType === "RENEWAL" && signedIn && !eligible;
  const [applicantType, setApplicantType] = useState<"NEW" | "RENEWAL">(autoIneligible ? "NEW" : seedType);
  const [ineligibleNote, setIneligibleNote] = useState(autoIneligible);
  // Seed the renewal department from the saved draft when it is still one the
  // applicant belongs to, so conditional department sections re-render on resume.
  const [renewalDept, setRenewalDept] = useState<string>(() =>
    initialRenewalDepartment && currentDepartments.includes(initialRenewalDepartment)
      ? initialRenewalDepartment
      : (currentDepartments[0] ?? ""),
  );
  // Seed the department choice from the saved draft answer so its conditional
  // section is visible immediately on resume (instead of collapsing to "").
  const [deptChoice, setDeptChoice] = useState<string>(() => {
    const key = def.sections.flatMap((s) => s.fields).find((f) => f.type === "DEPARTMENT_CHOICE")?.key;
    return key ? prefillString(prefill?.values[key] ?? initialAnswers[key]) : "";
  });
  const [result, setResult] = useState<SubmitResult | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Autosave state
  const formRef = useRef<HTMLFormElement | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved">("idle");

  // Per-file-field upload status: key -> "Attached: <name>" or error message.
  // Seed from the draft so a previously uploaded file shows as attached on resume.
  const [fileStatus, setFileStatus] = useState<Record<string, string>>(() => {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(initialAnswers)) {
      if (v && typeof v === "object" && "fileName" in (v as object)) {
        out[k] = `Attached: ${(v as { fileName: string }).fileName}`;
      }
    }
    return out;
  });

  const lockedKeys = useMemo(() => new Set(prefill?.lockedKeys ?? []), [prefill]);
  const loginHref = `/login?callbackUrl=${encodeURIComponent(`/apply/${def.slug}?type=renewal`)}`;
  const renewalGate = applicantType === "RENEWAL" && !signedIn;
  const roleNoun = def.track === "DIRECTOR" ? "director" : "volunteer";
  const applicantOptions = [
    { value: "NEW" as const, label: "New applicant", desc: "First time applying" },
    { value: "RENEWAL" as const, label: `Returning ${roleNoun}`, desc: "Renewing in my current department" },
  ];

  function chooseType(v: "NEW" | "RENEWAL") {
    if (v === "RENEWAL" && signedIn && !eligible) {
      setApplicantType("NEW");
      setIneligibleNote(true);
      return;
    }
    setIneligibleNote(false);
    setApplicantType(v);
  }

  function scheduleSave() {
    if (renewalGate) return; // not identified for renewal yet; nothing to save
    if (saveTimer.current) clearTimeout(saveTimer.current);
    setSaveState("saving");
    saveTimer.current = setTimeout(async () => {
      const form = formRef.current;
      if (!form) return;
      const fd = new FormData(form);
      const answers: Record<string, unknown> = {};
      for (const [k, v] of fd.entries()) {
        if (k.startsWith("__") || v instanceof File) continue;
        answers[k] = answers[k] === undefined ? v : ([] as unknown[]).concat(answers[k], v);
      }
      const res = await saveDraftAction(def.slug, {
        answers,
        applicantType,
        renewalDepartment: applicantType === "RENEWAL" ? renewalDept : null,
      });
      setSaveState(res.ok ? "saved" : "idle");
    }, 800);
  }

  async function handleFileChange(fieldKey: string, e: React.ChangeEvent<HTMLInputElement> | React.SyntheticEvent) {
    const input = (e.target as HTMLInputElement);
    const file = input.files?.[0];
    if (!file) return;
    setFileStatus((prev) => ({ ...prev, [fieldKey]: "Uploading..." }));
    const fd = new FormData();
    fd.set("file", file);
    const res = await uploadDraftFileAction(def.slug, fieldKey, fd);
    if (res.ok && res.fileName) {
      setFileStatus((prev) => ({ ...prev, [fieldKey]: `Attached: ${res.fileName}` }));
    } else {
      setFileStatus((prev) => ({ ...prev, [fieldKey]: res.error ?? "Upload failed." }));
    }
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
    <form ref={formRef} onSubmit={onSubmit} onChange={scheduleSave} className="mt-6">
      <Card className="space-y-6">
        {result && !result.ok && <Alert tone="error">{result.message}</Alert>}

        {saveState !== "idle" && (
          <p className="text-xs text-muted-foreground" aria-live="polite">
            {saveState === "saving" ? "Saving..." : "Saved"}
          </p>
        )}

        {def.acceptsRenewals && (
          <FormSection title={`Are you a new or returning ${roleNoun}?`}>
            <RadioGroup>
              {applicantOptions.map((opt) => (
                <Radio
                  key={opt.value}
                  name="__type_ui"
                  value={opt.value}
                  checked={applicantType === opt.value}
                  onChange={() => chooseType(opt.value)}
                  label={
                    <>
                      <span className="font-medium">{opt.label}</span>
                      <span className="block text-xs text-muted-foreground">{opt.desc}</span>
                    </>
                  }
                />
              ))}
            </RadioGroup>

            {ineligibleNote && (
              <Alert tone="warning">We do not see a current {roleNoun} membership for your account, so we have set you up as a new applicant. Your name and email are filled in below.</Alert>
            )}

            {applicantType === "RENEWAL" && signedIn && eligible && (
              currentDepartments.length > 1 ? (
                <Field label="Current department">
                  <Select value={renewalDept} onChange={(e) => setRenewalDept(e.target.value)} className="sm:max-w-xs">
                    {currentDepartments.map((d) => <option key={d} value={d}>{d}</option>)}
                  </Select>
                </Field>
              ) : (
                <ReadonlyField
                  label="Current department"
                  value={renewalDept}
                  hint="You are renewing in your current department. Contact us if this needs to change."
                />
              )
            )}
          </FormSection>
        )}

        {renewalGate ? (
          <div className="space-y-3">
            <p className="text-sm text-foreground">Returning {roleNoun}s sign in with Yale so we can verify your renewal and fill in your information.</p>
            <a href={loginHref} className={`${buttonClasses("primary", "md")} mt-3`}>Sign in with Yale</a>
          </div>
        ) : (
          <>
            {signedIn && applicantType === "RENEWAL" && eligible && signedInName && (
              <p className="text-sm text-muted-foreground">Signed in as {signedInName}.</p>
            )}

            {visible.map((section) => (
              <FormSection key={section.id} title={section.title} description={section.description ?? undefined}>
                {section.fields.map((f) =>
                  f.type === "FILE" ? (
                    // FILE fields: intercept onChange here so files upload immediately
                    // and do not flow into the text autosave path.
                    <div key={f.key} onChange={(e) => { e.stopPropagation(); handleFileChange(f.key, e as unknown as React.ChangeEvent<HTMLInputElement>); }}>
                      <FieldPreview f={f} departments={def.departments} subcommittees={def.subcommittees}
                        fieldError={result && !result.ok ? result.fieldErrors?.[f.key] : undefined}
                        onDeptChoice={undefined}
                        prefill={prefill?.values[f.key] ?? initialAnswers[f.key]} locked={lockedKeys.has(f.key)} />
                      {fileStatus[f.key] && (
                        <p className="mt-1 text-xs text-muted-foreground">{fileStatus[f.key]}</p>
                      )}
                    </div>
                  ) : (
                    <FieldPreview key={f.key} f={f} departments={def.departments} subcommittees={def.subcommittees}
                      fieldError={result && !result.ok ? result.fieldErrors?.[f.key] : undefined}
                      onDeptChoice={f.type === "DEPARTMENT_CHOICE" ? setDeptChoice : undefined}
                      prefill={prefill?.values[f.key] ?? initialAnswers[f.key]} locked={lockedKeys.has(f.key)} />
                  )
                )}
              </FormSection>
            ))}

            <FormActions>
              <Button type="submit" disabled={submitting}>{submitting ? "Submitting..." : "Submit application"}</Button>
            </FormActions>
          </>
        )}
      </Card>
    </form>
  );
}
