"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import posthog from "posthog-js";
import type { EpicRequirement, Track } from "@prisma/client";
import { submitOnboarding, type SubmitResult } from "./actions";
import { ContractField } from "./contract-field";
import { DetailsReview, isReviewableBlock } from "./details-review";
import { NextStepsScreen } from "./next-steps-screen";
import { Alert } from "@/platform/ui/alert";
import { SubmitButton } from "@/platform/ui/submit-button";
import { Card } from "@/platform/ui/card";
import { FormActions } from "@/platform/ui/form";
import { visibleOnboardingBlocks } from "@/modules/recruitment/contract/visibility";
import type { ContractLayout } from "@/modules/recruitment/contract/layout";

/**
 * The most file data one submit may carry. The platform refuses a request body
 * over ~4.5 MB at the edge, before submitContract runs (platform/config.ts), and
 * the signatures and text fields ride along in the same body, so this keeps a
 * margin under that.
 */
const MAX_SUBMIT_FILE_BYTES = 4_300_000;

type Prefill = { firstName: string; legalMiddleName?: string; lastName: string; preferredFirstName: string; email: string; netId: string; phone: string; pronouns?: string; yaleAffiliation: string; gradYear: string; staffTitle?: string };
type Ctx = {
  firstName: string; orgName: string; todayIso: string;
  trainingDate: string; trainingLocation: string;
  department: string | null; track: Track; epicRequirement: EpicRequirement;
  storedEpicId: string | null;
  /** Departments they are also accepted into as a dual appointment. */
  additionalDepartments?: string[];
  /** Labelled clinic dates from the application, for the availability check. */
  applicationAvailability?: string[];
  /** A HIPAA certificate on file that covers the term; the upload becomes optional. */
  hipaaOnFile?: { completionDate: string; expiresAt: string; pendingVerification: boolean } | null;
  /** The stored profile photo as a data URI; a new photo becomes optional. */
  photoOnFile?: string | null;
};

export function OnboardForm({
  token, prefill, layout, ctx, departments = [], maxUploadMb = 4,
}: {
  token: string;
  prefill: Prefill;
  layout: ContractLayout;
  ctx: Ctx;
  // Active department codes, threaded down to every ContractField for the
  // DEPARTMENT_CHOICE custom-question case. Defaults to [] so existing tests
  // that never render a DEPARTMENT_CHOICE block keep typechecking; the real
  // onboard page always supplies the loaded list.
  departments?: string[];
  /** `uploads.maxMb`, threaded to the HIPAA upload. See ContractField. */
  maxUploadMb?: number;
}) {
  const [result, setResult] = useState<SubmitResult | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // Free-form answers the applicant has entered so far (selects, checkboxes,
  // custom questions). Merged with the authoritative server context below via
  // buildContractAnswers before every visibility check, so a hostile or stale
  // form field of the same name can never override department/track/Epic
  // requirement.
  //
  // Seeded from prefill on first render, mirroring apply-wizard.tsx's answers
  // seeding: several fields (yaleAffiliation, gradYear, netId, phone,
  // firstName, lastName, email) render with defaultValue and never fire
  // onChange on mount, so without this seed a prefilled value that gates
  // another block (e.g. staffTitle's visibleWhen on yaleAffiliation ===
  // "staff") would evaluate against an empty answers map on the first render
  // and hide a block the applicant never gets a chance to answer. firstName/
  // lastName/email are not controllers of any shipped default today, but the
  // server always reconstructs them into its own answers map (submitContract),
  // so seeding them here keeps the client's first render from diverging if a
  // future condition keys on one. department/track/epicRequirement are
  // deliberately NOT seeded here: they are authoritative context that
  // buildContractAnswers strips out of formAnswers and overrides from ctx on
  // every call, so seeding them would do nothing except be misleading.
  const [answers, setAnswers] = useState<Record<string, string | string[]>>(() => {
    const seed: Record<string, string | string[]> = {};
    if (prefill.yaleAffiliation) seed.yaleAffiliation = prefill.yaleAffiliation;
    if (prefill.gradYear) seed.gradYear = prefill.gradYear;
    if (prefill.netId) seed.netId = prefill.netId;
    if (prefill.phone) seed.phone = prefill.phone;
    if (prefill.firstName) seed.firstName = prefill.firstName;
    if (prefill.lastName) seed.lastName = prefill.lastName;
    if (prefill.email) seed.email = prefill.email;
    return seed;
  });
  const onAnswer = useCallback((name: string, value: string | string[]) => {
    setAnswers((prev) => ({ ...prev, [name]: value }));
  }, []);

  // This contract has no draft save: nothing the volunteer types is persisted
  // until they submit, and a reload loses all of it including every signature.
  // The form also asks for a HIPAA certificate PDF that a new volunteer has to
  // leave the page to fetch from Yale, so leaving mid-form is the ordinary path
  // through it rather than an edge case. Until draft save exists, warn on the
  // way out.
  //
  // Tracked from the form's own change/input events rather than from `answers`,
  // because several fields never route through onAnswer: uncontrolled
  // defaultValue inputs, the file input, and the signature pads. React's
  // synthetic events bubble, so one handler on the <form> catches all of them.
  const [dirty, setDirty] = useState(false);
  const markDirty = useCallback(() => setDirty(true), []);

  useEffect(() => {
    // Not while submitting (the navigation is ours), and not once the
    // submission succeeded (the work is safe, and the success screen renders
    // from this same component).
    if (!dirty || submitting || result?.ok) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty, submitting, result?.ok]);

  // Where a rejected submit sends the reader. This form runs to thirty-odd
  // fields, and its submit button is at the very bottom, so a refusal used to
  // land entirely off-screen: the summary renders above the FIRST field, the
  // page does not scroll, and focus stays on the button. Pressing Submit looked
  // like it had done nothing at all.
  //
  // Alert tone="error" already carries role="alert", so the message was
  // announced; what was missing was getting the reader TO it. Mirrors the apply
  // wizard's step-heading focus (apply-wizard.tsx:394), including the
  // requestAnimationFrame, which waits for the summary to be in the DOM before
  // focusing it.
  const errorSummaryRef = useRef<HTMLDivElement>(null);

  // A net under the silent submit dead-end #910 fixed. A `required` control the
  // browser cannot focus -- one rendered inside a `hidden` wrapper, as
  // DetailsReview hides a summarized detail -- fails constraint validation, but
  // the browser aborts the submit with no message anywhere and never runs
  // onSubmit. It emitted no event either, so the last time this shipped it
  // surfaced only as dead clicks on the button. This listens for the native
  // refusal so it is measurable, and re-opens the summary when the blamed
  // control is hidden, so the applicant is never left pressing a button that
  // does nothing. A refusal on a VISIBLE required field is left untouched: the
  // browser already focuses it and says what is wrong.
  const formRef = useRef<HTMLFormElement>(null);
  useEffect(() => {
    const form = formRef.current;
    if (!form) return;
    // The invalid event does not bubble, so a form-level listener sees a
    // descendant's refusal only in the capture phase. All of a submit attempt's
    // refusals fire synchronously, so they are batched into one signal.
    let blocked: string[] = [];
    let hidden = false;
    let scheduled = false;
    const onInvalid = (e: Event) => {
      const control = e.target as Element | null;
      if (!control) return;
      // The `hidden` attribute is how the contract hides a summarized field's
      // inputs, and a required one inside it is exactly what the browser refuses
      // AND cannot focus. Stop the default (a prompt on a control no one can
      // see) and take the reader to the summary instead.
      if (control.closest("[hidden]")) {
        e.preventDefault();
        hidden = true;
      }
      blocked.push(control.getAttribute("name") || "(unnamed)");
      if (scheduled) return;
      scheduled = true;
      queueMicrotask(() => {
        posthog.capture("onboarding_submit_blocked", { fields: blocked, field_count: blocked.length, hidden });
        if (hidden) {
          setResult({
            ok: false,
            message:
              "We couldn't submit your onboarding. A required detail is missing but not shown on the form. Please reload the page, and contact us if this keeps happening.",
          });
          requestAnimationFrame(() => errorSummaryRef.current?.focus());
        }
        blocked = [];
        hidden = false;
        scheduled = false;
      });
    };
    form.addEventListener("invalid", onInvalid, true);
    return () => form.removeEventListener("invalid", onInvalid, true);
  }, []);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const formData = new FormData(e.currentTarget);
    // Each upload field refuses a file over its own cap, but the certificate and
    // the photo travel together, so check what they add up to before posting.
    // Over the platform limit the POST fails at the edge with no message at all.
    const fileBytes = [...formData.values()].reduce((n, v) => (typeof v === "string" ? n : n + v.size), 0);
    if (fileBytes > MAX_SUBMIT_FILE_BYTES) {
      setResult({
        ok: false,
        message: "Your HIPAA certificate and photo are too large to send together. Use a smaller certificate PDF or a different photo, then submit again.",
      });
      requestAnimationFrame(() => errorSummaryRef.current?.focus());
      return;
    }
    setSubmitting(true);
    try {
      const res = await submitOnboarding(token, formData);
      setResult(res);
      if (!res.ok) requestAnimationFrame(() => errorSummaryRef.current?.focus());
    } catch {
      // A blob/DB failure inside submitContract would otherwise re-throw and
      // freeze the button on "Submitting..." with no feedback. Surface a
      // retryable error and always re-enable submit.
      setResult({ ok: false, message: "Something went wrong submitting your onboarding. Please try again." });
      requestAnimationFrame(() => errorSummaryRef.current?.focus());
    } finally {
      setSubmitting(false);
    }
  }

  if (result?.ok) {
    return <NextStepsScreen steps={result.nextSteps} />;
  }

  const err = (k: string) => (result && !result.ok ? result.fieldErrors?.[k] : undefined);
  // How many fields the server rejected. Worth saying in the summary: the
  // per-field messages are scattered down a long form, and "please try again"
  // alone does not tell you whether one date is wrong or eight.
  const fieldErrorCount =
    result && !result.ok ? Object.keys(result.fieldErrors ?? {}).length : 0;

  // Client-side visibility mirrors the server: both call visibleOnboardingBlocks,
  // the same helper the builder preview uses, so the two can never diverge. It
  // handles both the enabled/core filter (dropping optional system fields a
  // director turned off entirely) and the visibleWhen evaluation against the
  // applicant's answers merged with the authoritative context.
  const shown = visibleOnboardingBlocks(layout, answers, {
    department: ctx.department, additionalDepartments: ctx.additionalDepartments,
    track: ctx.track, epicRequirement: ctx.epicRequirement,
    storedEpicId: ctx.storedEpicId,
  });

  // What to fetch before starting: only the uploads this layout actually asks
  // for, since a director can remove either block.
  const asked = (key: string) => shown.some((b) => b.kind === "system_field" && b.systemKey === key);
  const toHaveReady = [
    asked("hipaa") && !ctx.hipaaOnFile ? "your HIPAA certificate PDF" : null,
    asked("photo") && !ctx.photoOnFile ? "a clear photo of your face" : null,
  ].filter(Boolean).join(" and ");

  // The details the application already collected render as one summary with an
  // "Update" option, placed where the first of them sits, instead of as a page of
  // inputs to re-read. Their inputs still render inside it (hidden), so the
  // values post and visibility is computed exactly as before -- except a
  // required detail the application never collected, which DetailsReview asks
  // as a visible field rather than hiding a control the browser then refuses
  // to submit.
  const reviewBlocks = shown.filter(isReviewableBlock);
  const firstReviewIndex = shown.findIndex(isReviewableBlock);
  const field = (b: (typeof shown)[number]) => (
    <ContractField
      key={"id" in b ? b.id : b.kind === "system_field" ? b.systemKey : b.key}
      block={b} prefill={prefill} ctx={ctx} err={err} onAnswer={onAnswer} departments={departments}
      maxUploadMb={maxUploadMb}
    />
  );

  return (
    <form ref={formRef} onSubmit={onSubmit} onChange={markDirty} onInput={markDirty} className="mt-6">
      <Card className="space-y-6">
        {/* Sits above the first field, not beside the submit button: it is only
            useful before someone starts typing. The certificate sentence is
            conditional because a director can remove the HIPAA block from the
            layout, and telling a volunteer to go fetch a document this form
            never asks for would be worse than saying nothing. */}
        <Alert tone="info">
          Nothing is saved until you submit this form.
          {toHaveReady
            ? ` Have ${toHaveReady} ready before you start, and set aside a few minutes to finish in one sitting.`
            : " Set aside a few minutes to finish in one sitting."}
        </Alert>

        {result && !result.ok && (
          // tabIndex -1 so focus can be moved here programmatically without
          // adding a tab stop people have to pass through on every attempt.
          <div ref={errorSummaryRef} tabIndex={-1} className="outline-none">
            <Alert tone="error">
              {result.message}
              {fieldErrorCount > 0 && (
                <>
                  {" "}
                  {fieldErrorCount === 1
                    ? "One field below needs attention."
                    : `${fieldErrorCount} fields below need attention.`}
                </>
              )}
            </Alert>
          </div>
        )}

        {shown.map((b, i) => {
          if (!isReviewableBlock(b)) return field(b);
          if (i !== firstReviewIndex) return null;
          return (
            <DetailsReview key="details-review" blocks={reviewBlocks} prefill={prefill} err={err} renderField={field} />
          );
        })}

        <FormActions>
          <SubmitButton disabled={submitting}>{submitting ? "Submitting…" : "Submit onboarding"}</SubmitButton>
        </FormActions>
      </Card>
    </form>
  );
}
