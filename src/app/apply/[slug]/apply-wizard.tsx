"use client";
import { useMemo, useRef, useState } from "react";
import { submitPublicApplication, type SubmitResult } from "./actions";
import { saveDraftAction, uploadDraftFileAction } from "./draft-actions";
import { deriveSteps, stepIndexForKeys, type WizardSection, type WizardStep } from "./wizard-steps";
import { missingRequiredKeys } from "./wizard-validation";
import { mergeDepartmentAnswer, parseFieldCondition, visibleFields, isFieldVisible } from "@/modules/recruitment/engine/field-visibility";
import { WizardProgress } from "./wizard-progress";
import { WizardReview, formatFieldValue, type ReviewGroup } from "./wizard-review";
import { applicantTypeLabel, type ApplicantType } from "@/modules/recruitment/engine/visibility";
import { Alert } from "@/platform/ui/alert";
import { Button } from "@/platform/ui/button";
import { Select } from "@/platform/ui/select";
import { Field, ReadonlyField } from "@/platform/ui/input";
import { Card } from "@/platform/ui/card";
import { FormSection, linkifyUrls } from "@/platform/ui/form";
import { RadioGroup, Radio } from "@/platform/ui/radio";
import { FieldPreview } from "@/modules/recruitment/components/field-preview";
import { prefillString } from "@/modules/recruitment/components/field-prefill";
import { SignaturePad } from "@/platform/ui/signature-pad";
import { cx } from "@/platform/ui/cx";
import { PortalNotice } from "../portal-notice";
import { YaleSignInButton } from "../yale-sign-in-button";

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
  // The same code -> name options page.tsx already resolves for the
  // DEPARTMENT_CHOICE field's own options. Reused here so the renewal-
  // department picker, its review-step row, and the transfer-blocked alert
  // show the department name instead of the raw code, matching the
  // new-applicant path. A code with no matching option falls back to the
  // code itself, same as departmentChoiceOptions does.
  departmentOptions?: { value: string; label: string }[];
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
  departmentOptions = [],
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
  // The step a failed submit sent the applicant back to, so the page-level error
  // banner can be pinned there instead of trailing them across every step. null
  // means the failure had no field to blame (duplicate application, closed cycle,
  // a signature storage throw), so the banner shows wherever they are: the review.
  const [errorStepIndex, setErrorStepIndex] = useState<number | null>(null);
  const [stepIndex, setStepIndex] = useState(0);
  const [editingReturn, setEditingReturn] = useState(false);
  const [reviewGroups, setReviewGroups] = useState<ReviewGroup[]>([]);

  const formRef = useRef<HTMLFormElement | null>(null);
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");

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
  const renewalGate = applicantType === "RENEWAL" && !signedIn;
  const roleNoun = def.track === "DIRECTOR" ? "director" : "volunteer";
  // Resolves a department code to its display name through the same
  // code -> name options the DEPARTMENT_CHOICE field itself renders
  // (departmentOptions, injected by page.tsx). Falls back to the code when no
  // option matches, mirroring departmentChoiceOptions' own fallback -- so a
  // renewal/transfer department stays legible everywhere a NEW applicant's
  // department choice already is: the renewal picker, its review row, and the
  // transfer-blocked alert.
  const departmentLabel = (code: string) => departmentOptions.find((o) => o.value === code)?.label ?? code;

  const applicantOptions = [
    { value: "NEW" as const, label: "New applicant", desc: "First time applying", show: true },
    { value: "RENEWAL" as const, label: "Renewing in my current department", desc: `Continue as a ${roleNoun} in a department you are already in`, show: !signedIn || eligible },
    { value: "TRANSFER" as const, label: "Transferring to a new department", desc: `Return as a ${roleNoun} in a different department`, show: signedIn && isReturning },
  ].filter((o) => o.show);

  const selectedDepartmentCodes = useMemo(
    () => (applicantType === "RENEWAL" ? (renewalDept ? [renewalDept] : []) : deptChoice ? [deptChoice] : []),
    [applicantType, renewalDept, deptChoice],
  );

  const steps = useMemo<WizardStep[]>(
    () => deriveSteps({ sections: def.sections, acceptsRenewals: def.acceptsRenewals, applicantType, selectedDepartmentCodes }),
    [def.sections, def.acceptsRenewals, applicantType, selectedDepartmentCodes],
  );

  // Owning section per field key + the set of currently-visible section ids, used to
  // drop a controller's stale value once its section is hidden (below).
  const keyToSectionId = useMemo(() => {
    const m = new Map<string, string>();
    for (const s of def.sections) for (const f of s.fields) m.set(f.key, s.id);
    return m;
  }, [def.sections]);
  // A controller's own visibleWhen, so effectiveAnswers can also drop a controller
  // that is itself condition-hidden (not only section-hidden).
  const keyToVisibleWhen = useMemo(() => {
    const m = new Map<string, unknown>();
    for (const s of def.sections) for (const f of s.fields) m.set(f.key, f.visibleWhen);
    return m;
  }, [def.sections]);
  const visibleSectionIds = useMemo(
    () => new Set(steps.filter((st) => st.kind === "section").map((st) => st.id)),
    [steps],
  );

  // Answers used for field-level visibility: `answers` (pruned to controllers whose
  // owning section is still visible) merged with the authoritative department
  // selection (see mergeDepartmentAnswer) so a field condition keyed on the
  // department-choice field is correct regardless of navigation path.
  //
  // Pruning matters: the server strips any field whose visibleWhen controller is
  // absent from the submitted form. If a controller A lives in a section that becomes
  // hidden, A unmounts and is never submitted, so a dependent B keyed on A must be
  // hidden here too -- otherwise the review would show B answered while the server
  // silently drops it. Retaining A in `answers` state (not pruned there) keeps the
  // value if the section is shown again. Separate from the department -> section
  // visibility mechanism (deriveSteps/isSectionVisible), which reads
  // selectedDepartmentCodes directly.
  const effectiveAnswers = useMemo(() => {
    let current: Record<string, string | string[]> = {};
    for (const [k, v] of Object.entries(answers)) {
      const sid = keyToSectionId.get(k);
      if (sid === undefined || visibleSectionIds.has(sid)) current[k] = v;
    }
    // Also drop any controller hidden by its OWN visibleWhen. Such a controller is
    // unmounted, so it is absent from the submitted FormData and the server never
    // sees it, but its last value survives in React state. Removing one controller
    // can hide another that is gated on it, so iterate to a fixpoint. Without this
    // the client can show a question the server will silently discard.
    for (;;) {
      const merged = mergeDepartmentAnswer(current, departmentChoiceKey, selectedDepartmentCodes);
      const next: Record<string, string | string[]> = {};
      let changed = false;
      for (const [k, v] of Object.entries(current)) {
        if (!isFieldVisible(keyToVisibleWhen.get(k), merged)) { changed = true; continue; }
        next[k] = v;
      }
      current = next;
      if (!changed) break;
    }
    return mergeDepartmentAnswer(current, departmentChoiceKey, selectedDepartmentCodes);
  }, [answers, keyToSectionId, keyToVisibleWhen, visibleSectionIds, departmentChoiceKey, selectedDepartmentCodes]);
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
      // A failed draft save must not silently collapse to "idle" (visually identical
      // to never-having-saved) -- surface it so the applicant knows their answers may
      // not be persisted before they close the tab. saveDraftAction returns {ok:false}
      // only for a missing identity / DraftError; a transport failure (offline, 502) or
      // a non-DraftError (e.g. Prisma) REJECTS, which without this catch would leave the
      // indicator stuck on "Saving…" forever -- exactly the case the "check your
      // connection" copy was written for but could never reach (#34).
      try {
        const res = await saveDraftAction(def.slug, {
          answers: draftAnswers,
          applicantType,
          renewalDepartment: applicantType === "RENEWAL" ? renewalDept : null,
        });
        setSaveState(res.ok ? "saved" : "error");
      } catch {
        setSaveState("error");
      }
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
    // Same hazard as scheduleSave: a Blob putObject / transport failure REJECTS rather
    // than returning {ok:false}, which without this catch leaves the field stuck on
    // "Uploading..." forever (#34).
    try {
      const res = await uploadDraftFileAction(def.slug, fieldKey, fd);
      setFileStatus((prev) => ({ ...prev, [fieldKey]: res.ok && res.fileName ? `Attached: ${res.fileName}` : res.error ?? "Upload failed." }));
    } catch {
      setFileStatus((prev) => ({ ...prev, [fieldKey]: "Upload failed. Try again." }));
    }
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
            ...(applicantType === "RENEWAL" ? [{ label: "Department", value: departmentLabel(renewalDept) }] : []),
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
      // Validate against the same department-merged answers used to render the
      // fields (effectiveAnswers), not the raw form values. A renewal's department
      // is not in the raw form (the DEPARTMENT_CHOICE control isn't rendered), so
      // without this merge a shown, department-conditional required field would be
      // evaluated as hidden and could be skipped.
      if (departmentChoiceKey) values[departmentChoiceKey] = selectedDepartmentCodes;
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
      // Leaving the step a failed submit blamed, with its required fields now
      // satisfied: retire the banner too. Otherwise navigating back here later
      // would resurrect a message about an error that has already been fixed.
      if (stepIndex === errorStepIndex) {
        setErrorStepIndex(null);
        setResult(null);
      }
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
    try {
      const fd = new FormData(e.currentTarget);
      fd.set("__applicantType", applicantType);
      if (applicantType === "RENEWAL") fd.set("__renewalDepartment", renewalDept);
      const res = await submitPublicApplication(def.slug, fd);
      let bounceTo: number | null = null;
      if (!res.ok && res.fieldErrors) {
        setFieldErrors(res.fieldErrors);
        bounceTo = stepIndexForKeys(steps, Object.keys(res.fieldErrors));
        // editStep, not goTo: it sets editingReturn so a single Continue takes
        // them straight back to the review rather than re-walking every step
        // between the offending one and the end of the form.
        if (bounceTo != null) editStep(bounceTo);
      }
      setErrorStepIndex(bounceTo);
      setResult(res);
    } catch {
      // A server-action throw (e.g. a signature blob-storage or DB failure) would
      // otherwise leave the button stuck on "Submitting…" with no feedback. Show a
      // retryable error and always re-enable the button. This failure blames no
      // field, so clear any step a previous submit pinned the banner to, or it
      // would render on that step instead of the review the applicant is on.
      setErrorStepIndex(null);
      setResult({ ok: false, message: "Something went wrong submitting your application. Please try again." });
    } finally {
      setSubmitting(false);
    }
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

        {result && !result.ok && (errorStepIndex === null || stepIndex === errorStepIndex) && (
          <Alert tone="error">{result.message}</Alert>
        )}
        {saveState !== "idle" && (
          <p className={`text-xs ${saveState === "error" ? "text-critical" : "text-muted-foreground"}`} aria-live="polite">{saveState === "saving" ? "Saving…" : saveState === "error" ? "Couldn't save your draft, check your connection" : "Saved"}</p>
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
                        {currentDepartments.map((d) => <option key={d} value={d}>{departmentLabel(d)}</option>)}
                      </Select>
                    </Field>
                  ) : (
                    <ReadonlyField label="Current department" value={departmentLabel(renewalDept)} hint="You are renewing in your current department. Contact us if this needs to change." />
                  )
                )}
              </FormSection>
            </Card>

            {renewalGate && (
              <Card className="space-y-3">
                <p className="text-sm text-foreground">Returning {roleNoun}s sign in with Yale so we can verify your renewal and fill in your information.</p>
                <YaleSignInButton next={`/apply/${def.slug}?type=renewal`} className="w-full sm:w-auto" />
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
                <FormSection description={st.section.description ? linkifyUrls(st.section.description) : undefined}>
                  {visibleFields(st.section.fields, effectiveAnswers).map((f) =>
                    f.type === "SIGNATURE" ? (
                      <SignaturePad
                        key={f.key}
                        name={f.key}
                        label={f.label}
                        required={f.required}
                        helpText={f.helpText}
                        personName={[initialAnswers.first_name ?? prefill?.values.first_name, initialAnswers.last_name ?? prefill?.values.last_name].filter(Boolean).join(" ")}
                        defaultValue={typeof initialAnswers[f.key] === "string" ? (initialAnswers[f.key] as string) : ""}
                        defaultMethod={initialAnswers[`${f.key}__method`] === "type" ? "type" : "draw"}
                        defaultName={typeof initialAnswers[`${f.key}__name`] === "string" ? (initialAnswers[`${f.key}__name`] as string) : ""}
                        error={fieldErrors[f.key]}
                        onChange={scheduleSave}
                        // Mirror the signature's presence into the visibility map
                        // (marker, not the large data URL) so a field gated on this
                        // signature reacts exactly like a FILE-gated one.
                        onValueChange={(value) => handleValueChange(f.key, value ? "attached" : "")}
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
                        // Prefill (the Person record) wins only for LOCKED keys (email, net_id).
                        // For editable keys (first_name, last_name, phone) a saved draft answer is
                        // an explicit applicant edit and must win, or resuming the form silently
                        // reverts their correction back to the stale record value (#93).
                        prefill={lockedKeys.has(f.key) ? prefill?.values[f.key] : (initialAnswers[f.key] ?? prefill?.values[f.key])} locked={lockedKeys.has(f.key)} />
                    ),
                  )}
                </FormSection>
              </Card>
            </div>
          ) : null,
        )}

        {current.kind === "section" && transferIntoCurrent && (
          <Alert tone="warning">
            You are already a {roleNoun} in {departmentLabel(deptChoice)}. Choose &ldquo;Renewing in my current department&rdquo; to come back to it.
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
