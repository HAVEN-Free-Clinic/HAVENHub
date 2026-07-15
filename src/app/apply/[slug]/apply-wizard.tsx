"use client";
import { useMemo, useRef, useState } from "react";
import { submitPublicApplication, type SubmitResult } from "./actions";
import { saveDraftAction, uploadDraftFileAction } from "./draft-actions";
import { deriveSteps, stepIndexForKeys, type WizardSection, type WizardStep } from "./wizard-steps";
import { missingRequiredKeys } from "./wizard-validation";
import { mergeDepartmentAnswer, parseFieldCondition, visibleFields } from "@/modules/recruitment/engine/field-visibility";
import { WizardProgress } from "./wizard-progress";
import { WizardReview, formatFieldValue, type ReviewGroup } from "./wizard-review";
import { applicantTypeLabel, type ApplicantType } from "@/modules/recruitment/engine/visibility";
import { Alert } from "@/platform/ui/alert";
import { Button, buttonClasses } from "@/platform/ui/button";
import { Select } from "@/platform/ui/select";
import { Field, ReadonlyField } from "@/platform/ui/input";
import { Card } from "@/platform/ui/card";
import { FormSection } from "@/platform/ui/form";
import { RadioGroup, Radio } from "@/platform/ui/radio";
import { FieldPreview } from "@/modules/recruitment/components/field-preview";
import { prefillString } from "@/modules/recruitment/components/field-prefill";
import { SignaturePad } from "@/platform/ui/signature-pad";
import { cx } from "@/platform/ui/cx";
import { PortalNotice } from "../portal-notice";

type Def = {
  slug: string;
  title: string;
  track: "VOLUNTEER" | "DIRECTOR";
  acceptsRenewals: boolean;
  departments: string[];
  subcommittees: { id: string; name: string }[];
  sections: WizardSection[];
};
type Prefill = { values: Record<string, string>; lockedKeys: string[] };

export type ApplyWizardProps = {
  def: Def;
  signedIn?: boolean;
  signedInName?: string | null;
  eligible?: boolean;
  isReturning?: boolean;
  prefill?: Prefill;
  currentDepartments?: string[];
  initialApplicantType?: ApplicantType;
  initialAnswers?: Record<string, unknown>;
  initialApplicantTypeFromDraft?: ApplicantType;
  initialRenewalDepartment?: string | null;
};

export function ApplyWizard({
  def,
  signedIn = false,
  signedInName = null,
  eligible = false,
  isReturning = false,
  prefill,
  currentDepartments = [],
  initialApplicantType = "NEW",
  initialAnswers = {},
  initialApplicantTypeFromDraft,
  initialRenewalDepartment = null,
}: ApplyWizardProps) {
  const seedType = initialApplicantTypeFromDraft ?? initialApplicantType;
  const renewalUnavailable = seedType === "RENEWAL" && signedIn && !eligible;
  const transferUnavailable = seedType === "TRANSFER" && (!signedIn || !isReturning);
  const autoIneligible = renewalUnavailable || transferUnavailable;

  const [applicantType, setApplicantType] = useState<ApplicantType>(autoIneligible ? "NEW" : seedType);
  const [ineligibleNote, setIneligibleNote] = useState(autoIneligible);
  const [renewalDept, setRenewalDept] = useState<string>(() =>
    initialRenewalDepartment && currentDepartments.includes(initialRenewalDepartment)
      ? initialRenewalDepartment
      : currentDepartments[0] ?? "",
  );
  const departmentChoiceKey = useMemo(
    () => def.sections.flatMap((s) => s.fields).find((f) => f.type === "DEPARTMENT_CHOICE")?.key,
    [def.sections],
  );
  const [deptChoice, setDeptChoice] = useState<string>(() =>
    departmentChoiceKey ? prefillString(prefill?.values[departmentChoiceKey] ?? initialAnswers[departmentChoiceKey]) : "",
  );

  // Field keys that some other field's visibleWhen condition depends on. Only
  // these need to live in reactive state (answers below) -- every other
  // keystroke can stay in the uncontrolled DOM without forcing a re-render.
  const controllingKeys = useMemo(
    () =>
      new Set(
        def.sections
          .flatMap((s) => s.fields)
          .map((f) => parseFieldCondition(f.visibleWhen)?.field)
          .filter((k): k is string => Boolean(k)),
      ),
    [def.sections],
  );

  // Single source of truth for condition-driven visibility (visibleFields
  // below reads only this map). Seeded from any resumed draft/prefill answer,
  // and mirrors deptChoice/renewalDept so a section-level department pick also
  // satisfies a field-level visibleWhen condition keyed on the same field.
  const [answers, setAnswers] = useState<Record<string, string | string[]>>(() => {
    const seed: Record<string, string | string[]> = {};
    for (const key of controllingKeys) {
      const raw = prefill?.values[key] ?? initialAnswers[key];
      if (typeof raw === "string") seed[key] = raw;
      else if (Array.isArray(raw) && raw.every((v) => typeof v === "string")) seed[key] = raw as string[];
      // A resumed draft's FILE answer is an object ({ storedName, fileName, ... };
      // storedName is the server's source-of-truth for "attached", mirroring the
      // same check field-preview.tsx uses for its own draftFile detection). FILE
      // controls never write a string/array value, so without this an
      // isAnswered condition on a resumed-with-attachment draft would wrongly
      // hide its dependent field.
      else if (raw && typeof raw === "object" && "storedName" in (raw as object)) seed[key] = "attached";
    }
    if (departmentChoiceKey && controllingKeys.has(departmentChoiceKey) && !(departmentChoiceKey in seed)) {
      const deptSeed = applicantType === "RENEWAL" ? renewalDept : deptChoice;
      if (deptSeed) seed[departmentChoiceKey] = deptSeed;
    }
    return seed;
  });

  // Generalizes the old DEPARTMENT_CHOICE-only onDeptChoice callback: deptChoice
  // always tracks the department control (it drives section-level visibility
  // via selectedDepartmentCodes), while answers only tracks keys that a
  // visibleWhen condition actually reads, to avoid re-rendering on every
  // unrelated keystroke.
  function handleValueChange(key: string, value: string | string[]) {
    if (key === departmentChoiceKey) setDeptChoice(typeof value === "string" ? value : value[0] ?? "");
    if (controllingKeys.has(key)) setAnswers((a) => ({ ...a, [key]: value }));
  }

  // Mirrors the renewal-department picker (a plain Select in the intro step,
  // not a FieldPreview control) into answers, so a visibleWhen condition keyed
  // on the department field also sees a renewing applicant's department.
  function handleRenewalDeptChange(v: string) {
    setRenewalDept(v);
    if (departmentChoiceKey && controllingKeys.has(departmentChoiceKey)) {
      setAnswers((a) => ({ ...a, [departmentChoiceKey]: v }));
    }
  }

  const [result, setResult] = useState<SubmitResult | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [stepIndex, setStepIndex] = useState(0);
  const [editingReturn, setEditingReturn] = useState(false);
  const [reviewGroups, setReviewGroups] = useState<ReviewGroup[]>([]);

  const formRef = useRef<HTMLFormElement | null>(null);
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved">("idle");

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
    { value: "NEW" as const, label: "New applicant", desc: "First time applying", show: true },
    { value: "RENEWAL" as const, label: "Renewing in my current department", desc: `Continue as a ${roleNoun} in a department you are already in`, show: !signedIn || eligible },
    { value: "TRANSFER" as const, label: "Transferring to a new department", desc: `Return as a ${roleNoun} in a different department`, show: signedIn && isReturning },
  ].filter((o) => o.show);

  const selectedDepartmentCodes = useMemo(
    () => (applicantType === "RENEWAL" ? (renewalDept ? [renewalDept] : []) : deptChoice ? [deptChoice] : []),
    [applicantType, renewalDept, deptChoice],
  );

  // Answers used for field-level visibility: `answers` merged with the
  // authoritative department selection (see mergeDepartmentAnswer) so a field
  // condition keyed on the department-choice field is correct regardless of
  // navigation path. This is separate from, and does not change, the existing
  // department -> section visibility mechanism (deriveSteps/isSectionVisible),
  // which already reads selectedDepartmentCodes directly.
  const effectiveAnswers = useMemo(
    () => mergeDepartmentAnswer(answers, departmentChoiceKey, selectedDepartmentCodes),
    [answers, selectedDepartmentCodes, departmentChoiceKey],
  );

  const steps = useMemo<WizardStep[]>(
    () => deriveSteps({ sections: def.sections, acceptsRenewals: def.acceptsRenewals, applicantType, selectedDepartmentCodes }),
    [def.sections, def.acceptsRenewals, applicantType, selectedDepartmentCodes],
  );
  const reviewIndex = steps.length - 1;

  // Clamp the pointer if the visible-step set shrinks below the current index.
  // Adjusted during render (React's documented pattern for state that must
  // track a derived value) rather than in an effect, so there is no extra
  // commit where the UI briefly shows an out-of-range step.
  const [prevReviewIndex, setPrevReviewIndex] = useState(reviewIndex);
  if (reviewIndex !== prevReviewIndex) {
    setPrevReviewIndex(reviewIndex);
    if (stepIndex > reviewIndex) setStepIndex(reviewIndex);
  }

  const transferIntoCurrent =
    applicantType === "TRANSFER" && deptChoice !== "" && currentDepartments.includes(deptChoice);

  function chooseType(v: ApplicantType) {
    if (v === "RENEWAL" && signedIn && !eligible) { setApplicantType("NEW"); setIneligibleNote(true); return; }
    if (v === "TRANSFER" && signedIn && !isReturning) { setApplicantType("NEW"); setIneligibleNote(true); return; }
    setIneligibleNote(false);
    setApplicantType(v);
  }

  function scheduleSave() {
    if (renewalGate) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    setSaveState("saving");
    saveTimer.current = setTimeout(async () => {
      const form = formRef.current;
      if (!form) return;
      const fd = new FormData(form);
      const draftAnswers: Record<string, unknown> = {};
      for (const [k, v] of fd.entries()) {
        if (k.startsWith("__") || v instanceof File) continue;
        draftAnswers[k] = draftAnswers[k] === undefined ? v : ([] as unknown[]).concat(draftAnswers[k], v);
      }
      const res = await saveDraftAction(def.slug, {
        answers: draftAnswers,
        applicantType,
        renewalDepartment: applicantType === "RENEWAL" ? renewalDept : null,
      });
      setSaveState(res.ok ? "saved" : "idle");
    }, 800);
  }

  async function handleFileChange(fieldKey: string, e: React.ChangeEvent<HTMLInputElement> | React.SyntheticEvent) {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    // A FILE control never writes to `answers` (its value isn't a meaningful
    // string/array), so an isAnswered condition on this field would never
    // react. Mirror presence with a marker instead -- the value's content is
    // irrelevant, isAnswered only checks non-empty. Gated the same as every
    // other field by handleValueChange's controllingKeys check.
    handleValueChange(fieldKey, file ? "attached" : "");
    if (!file) return;
    setFileStatus((prev) => ({ ...prev, [fieldKey]: "Uploading..." }));
    const fd = new FormData();
    fd.set("file", file);
    const res = await uploadDraftFileAction(def.slug, fieldKey, fd);
    setFileStatus((prev) => ({ ...prev, [fieldKey]: res.ok && res.fileName ? `Attached: ${res.fileName}` : res.error ?? "Upload failed." }));
  }

  // Serialize the form to a { key: string | string[] } map, marking attached
  // files with their file name so validation and review can see them.
  function collectValues(): Record<string, unknown> {
    const values: Record<string, unknown> = {};
    const form = formRef.current;
    if (form) {
      for (const [k, v] of new FormData(form).entries()) {
        if (k.startsWith("__") || v instanceof File) continue;
        values[k] = k in values ? ([] as unknown[]).concat(values[k], v) : v;
      }
    }
    for (const [k, label] of Object.entries(fileStatus)) {
      if (label.startsWith("Attached:")) values[k] = label.slice("Attached:".length).trim();
    }
    return values;
  }

  function buildGroups(values: Record<string, unknown>): ReviewGroup[] {
    const groups: ReviewGroup[] = [];
    steps.forEach((st, i) => {
      if (st.kind === "intro") {
        groups.push({
          stepIndex: i,
          title: "Getting started",
          rows: [
            { label: "Applying as", value: applicantTypeLabel(applicantType) },
            ...(applicantType === "RENEWAL" ? [{ label: "Department", value: renewalDept }] : []),
          ],
        });
      } else if (st.kind === "section") {
        groups.push({
          stepIndex: i,
          title: st.title,
          // Condition-hidden fields were never asked, so they are omitted here
          // too (rather than showing a misleading "Not provided" row).
          rows: visibleFields(st.section.fields, effectiveAnswers).map((f) => {
            const src = f.type === "SIGNATURE" && typeof values[f.key] === "string" && String(values[f.key]).startsWith("data:") ? String(values[f.key]) : undefined;
            return { label: f.label, value: src ? "" : formatFieldValue(f, values, def.subcommittees), imageSrc: src };
          }),
        });
      }
    });
    return groups;
  }

  function focusHeading() {
    requestAnimationFrame(() => headingRef.current?.focus());
  }
  function goTo(index: number) {
    setStepIndex(index);
    focusHeading();
  }

  function handleNext() {
    const cur = steps[stepIndex];
    if (cur.kind === "intro" && renewalGate) return;
    if (cur.kind === "section") {
      if (transferIntoCurrent) return; // blocked; the alert is shown in-step
      const values = collectValues();
      const missing = missingRequiredKeys(cur.section.fields, values);
      if (missing.length) {
        setFieldErrors((p) => ({ ...p, ...Object.fromEntries(missing.map((k) => [k, "This field is required."])) }));
        requestAnimationFrame(() => (formRef.current?.elements.namedItem(missing[0]) as HTMLElement | null)?.focus?.());
        return;
      }
      setFieldErrors((p) => {
        const next = { ...p };
        for (const f of cur.section.fields) delete next[f.key];
        return next;
      });
    }
    const target = editingReturn ? reviewIndex : stepIndex + 1;
    setEditingReturn(false);
    if (target === reviewIndex) setReviewGroups(buildGroups(collectValues()));
    goTo(target);
  }

  function editStep(index: number) {
    setEditingReturn(true);
    goTo(index);
  }

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (steps[stepIndex].kind !== "review") { handleNext(); return; }
    if (transferIntoCurrent) return;
    setSubmitting(true);
    const fd = new FormData(e.currentTarget);
    fd.set("__applicantType", applicantType);
    if (applicantType === "RENEWAL") fd.set("__renewalDepartment", renewalDept);
    const res = await submitPublicApplication(def.slug, fd);
    setSubmitting(false);
    if (!res.ok && res.fieldErrors) {
      setFieldErrors(res.fieldErrors);
      const idx = stepIndexForKeys(steps, Object.keys(res.fieldErrors));
      if (idx != null) goTo(idx);
    }
    setResult(res);
  }

  if (result?.ok) {
    return (
      <PortalNotice tone="success" titleAs="h1" title="Application received" className="mt-4">
        <p>Thanks, your application was received. Check your email for a confirmation.</p>
      </PortalNotice>
    );
  }

  const current = steps[stepIndex];
  const showContinue = !(current.kind === "intro" && renewalGate) && current.kind !== "review";

  return (
    <form ref={formRef} noValidate onSubmit={onSubmit} onChange={scheduleSave} className="grid gap-8 md:grid-cols-[220px_1fr]">
      <WizardProgress steps={steps.map((s) => ({ id: s.id, title: s.title }))} current={stepIndex} onJump={(i) => { setEditingReturn(false); goTo(i); }} />

      <div className="min-w-0 space-y-5">
        <div>
          <h1 className="text-sm font-medium text-muted-foreground">{def.title}</h1>
          <p className="hidden text-xs font-semibold uppercase tracking-wider text-brand-fg md:block">Step {stepIndex + 1} of {steps.length}</p>
          <h2 ref={headingRef} tabIndex={-1} className="mt-1 text-xl font-bold tracking-tight text-foreground outline-none">
            {current.kind === "intro" ? "Getting started" : current.kind === "review" ? "Review your application" : current.title}
          </h2>
        </div>

        {result && !result.ok && <Alert tone="error">{result.message}</Alert>}
        {saveState !== "idle" && (
          <p className="text-xs text-muted-foreground" aria-live="polite">{saveState === "saving" ? "Saving…" : "Saved"}</p>
        )}

        {current.kind === "intro" && (
          <>
            <Card className="space-y-4">
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
                      <Select value={renewalDept} onChange={(e) => handleRenewalDeptChange(e.target.value)} className="sm:max-w-xs">
                        {currentDepartments.map((d) => <option key={d} value={d}>{d}</option>)}
                      </Select>
                    </Field>
                  ) : (
                    <ReadonlyField label="Current department" value={renewalDept} hint="You are renewing in your current department. Contact us if this needs to change." />
                  )
                )}
              </FormSection>
            </Card>

            {renewalGate && (
              <Card className="space-y-3">
                <p className="text-sm text-foreground">Returning {roleNoun}s sign in with Yale so we can verify your renewal and fill in your information.</p>
                <a href={loginHref} className={buttonClasses("primary", "lg", "w-full sm:w-auto")}>Sign in with Yale</a>
              </Card>
            )}
          </>
        )}

        {current.kind === "section" && signedIn && (applicantType === "RENEWAL" ? eligible : applicantType === "TRANSFER" ? isReturning : false) && signedInName && (
          <p className="text-sm text-muted-foreground">Signed in as {signedInName}.</p>
        )}

        {/* All visible section steps stay mounted so their uncontrolled fields
            remain in the form (and in the final FormData); only the current one
            is shown. Intro/review controls are React state, so they render
            conditionally. */}
        {steps.map((st, i) =>
          st.kind === "section" ? (
            <div key={st.id} className={cx("space-y-4", i === stepIndex ? "block" : "hidden")}>
              <Card className="space-y-4">
                <FormSection description={st.section.description ?? undefined}>
                  {visibleFields(st.section.fields, effectiveAnswers).map((f) =>
                    f.type === "SIGNATURE" ? (
                      <SignaturePad
                        key={f.key}
                        name={f.key}
                        label={f.label}
                        required={f.required}
                        personName={[prefill?.values.first_name ?? initialAnswers.first_name, prefill?.values.last_name ?? initialAnswers.last_name].filter(Boolean).join(" ")}
                        defaultValue={typeof initialAnswers[f.key] === "string" ? (initialAnswers[f.key] as string) : ""}
                        error={fieldErrors[f.key]}
                        onChange={scheduleSave}
                      />
                    ) : f.type === "FILE" ? (
                      <div key={f.key} onChange={(e) => { e.stopPropagation(); handleFileChange(f.key, e as unknown as React.ChangeEvent<HTMLInputElement>); }}>
                        {/* The wizard owns the attached-file status line below (fileStatus),
                            so it must not also hand the draft file object to FieldPreview,
                            which would render a second "Attached: <file>" span. */}
                        <FieldPreview f={f} departments={def.departments} subcommittees={def.subcommittees}
                          fieldError={fieldErrors[f.key]} onValueChange={handleValueChange}
                          prefill={undefined} locked={lockedKeys.has(f.key)} />
                        {fileStatus[f.key] && <p className="mt-1 text-xs text-muted-foreground" role="status" aria-live="polite">{fileStatus[f.key]}</p>}
                      </div>
                    ) : (
                      <FieldPreview key={f.key} f={f} departments={def.departments} subcommittees={def.subcommittees}
                        fieldError={fieldErrors[f.key]}
                        onValueChange={handleValueChange}
                        prefill={prefill?.values[f.key] ?? initialAnswers[f.key]} locked={lockedKeys.has(f.key)} />
                    ),
                  )}
                </FormSection>
              </Card>
            </div>
          ) : null,
        )}

        {current.kind === "section" && transferIntoCurrent && (
          <Alert tone="warning">
            You are already a {roleNoun} in {deptChoice}. Choose &ldquo;Renewing in my current department&rdquo; to come back to it.
          </Alert>
        )}

        {current.kind === "review" && <WizardReview groups={reviewGroups} onEdit={editStep} />}

        <div className="flex items-center justify-between gap-3 border-t border-border-subtle pt-5">
          {stepIndex > 0 ? (
            <Button type="button" variant="outline" onClick={() => { setEditingReturn(false); goTo(stepIndex - 1); }}>Back</Button>
          ) : <span />}
          {showContinue && (
            <Button type="button" size="lg" onClick={handleNext} disabled={transferIntoCurrent}>Continue</Button>
          )}
          {current.kind === "review" && (
            <Button type="submit" size="lg" disabled={submitting || transferIntoCurrent}>{submitting ? "Submitting…" : "Submit application"}</Button>
          )}
        </div>
      </div>
    </form>
  );
}
