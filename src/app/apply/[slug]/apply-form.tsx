"use client";
import { useMemo, useRef, useState } from "react";
import { submitPublicApplication, type SubmitResult } from "./actions";
import { saveDraftAction, uploadDraftFileAction } from "./draft-actions";
import { isSectionVisible } from "@/modules/recruitment/engine/visibility";
import { Alert } from "@/platform/ui/alert";
import { Button, buttonClasses } from "@/platform/ui/button";
import { Select } from "@/platform/ui/select";
import { FieldPreview } from "@/modules/recruitment/components/field-preview";

function cx(...parts: (string | undefined | false | null)[]): string {
  return parts.filter(Boolean).join(" ");
}

type FieldDef ={ key: string; label: string; helpText: string | null; type: string; required: boolean; options: { value: string; label: string }[] | null; validation: Record<string, unknown> | null };
type SectionDef = { id: string; title: string; description: string | null; appliesTo: "NEW" | "RENEWAL" | "BOTH"; departmentCode: string | null; fields: FieldDef[] };
type Def = { slug: string; title: string; track: "VOLUNTEER" | "DIRECTOR"; acceptsRenewals: boolean; departments: string[]; subcommittees: { id: string; name: string }[]; sections: SectionDef[] };
type Prefill = { values: Record<string, string>; lockedKeys: string[] };

export function ApplyForm({
  def, signedIn = false, signedInName = null, eligible = false, prefill, currentDepartments = [], initialApplicantType = "NEW",
  initialAnswers = {}, initialApplicantTypeFromDraft,
}: {
  def: Def;
  signedIn?: boolean;
  signedInName?: string | null;
  eligible?: boolean;
  prefill?: Prefill;
  currentDepartments?: string[];
  initialApplicantType?: "NEW" | "RENEWAL";
  initialAnswers?: Record<string, string>;
  initialApplicantTypeFromDraft?: "NEW" | "RENEWAL";
}) {
  // Draft type takes precedence over the URL ?type param when present.
  const seedType = initialApplicantTypeFromDraft ?? initialApplicantType;

  // A returning visitor whose account has no current membership is moved to the
  // New flow on arrival, with a note.
  const autoIneligible = seedType === "RENEWAL" && signedIn && !eligible;
  const [applicantType, setApplicantType] = useState<"NEW" | "RENEWAL">(autoIneligible ? "NEW" : seedType);
  const [ineligibleNote, setIneligibleNote] = useState(autoIneligible);
  const [renewalDept, setRenewalDept] = useState<string>(currentDepartments[0] ?? "");
  const [deptChoice, setDeptChoice] = useState<string>("");
  const [result, setResult] = useState<SubmitResult | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Autosave state
  const formRef = useRef<HTMLFormElement | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved">("idle");

  // Per-file-field upload status: key -> "Attached: <name>" or error message
  const [fileStatus, setFileStatus] = useState<Record<string, string>>({});

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
    <form ref={formRef} onSubmit={onSubmit} onChange={scheduleSave} className="mt-6 space-y-8">
      {result && !result.ok && <Alert tone="error">{result.message}</Alert>}

      {saveState !== "idle" && (
        <p className="text-xs text-muted-foreground" aria-live="polite">
          {saveState === "saving" ? "Saving..." : "Saved"}
        </p>
      )}

      {def.acceptsRenewals && (
        <fieldset className="space-y-3">
          <legend className="text-sm font-medium text-foreground">Are you a new or returning {roleNoun}?</legend>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {applicantOptions.map((opt) => {
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
            <Alert tone="warning">We do not see a current {roleNoun} membership for your account, so we have set you up as a new applicant. Your name and email are filled in below.</Alert>
          )}

          {applicantType === "RENEWAL" && signedIn && eligible && (
            <label className="flex flex-col gap-1.5 pt-1">
              <span className="text-sm font-medium text-foreground">Current department</span>
              {currentDepartments.length > 1 ? (
                // Members of more than one department choose which one they are renewing in,
                // but only among their own departments.
                <Select value={renewalDept} onChange={(e) => setRenewalDept(e.target.value)} className="sm:max-w-xs">{currentDepartments.map((d) => <option key={d} value={d}>{d}</option>)}</Select>
              ) : (
                <>
                  <span className="rounded-lg border border-border bg-muted px-3 py-2 text-sm text-foreground sm:max-w-xs">{renewalDept}</span>
                  <span className="text-xs text-muted-foreground">You are renewing in your current department. Contact us if this needs to change.</span>
                </>
              )}
            </label>
          )}
        </fieldset>
      )}

      {renewalGate ? (
        <div className="rounded-xl border border-border bg-surface p-5">
          <p className="text-sm text-foreground">Returning {roleNoun}s sign in with Yale so we can verify your renewal and fill in your information.</p>
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
            </fieldset>
          ))}

          <Button type="submit" disabled={submitting}>{submitting ? "Submitting..." : "Submit application"}</Button>
        </>
      )}
    </form>
  );
}
