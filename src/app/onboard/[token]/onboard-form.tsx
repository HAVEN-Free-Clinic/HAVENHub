"use client";
import { useCallback, useState } from "react";
import type { EpicRequirement, Track } from "@prisma/client";
import { submitOnboarding, type SubmitResult } from "./actions";
import { ContractField } from "./contract-field";
import { NextStepsScreen } from "./next-steps-screen";
import { Alert } from "@/platform/ui/alert";
import { SubmitButton } from "@/platform/ui/submit-button";
import { Card } from "@/platform/ui/card";
import { FormActions } from "@/platform/ui/form";
import { visibleOnboardingBlocks } from "@/modules/recruitment/contract/visibility";
import type { ContractLayout } from "@/modules/recruitment/contract/layout";

type Prefill = { firstName: string; lastName: string; email: string; netId: string; phone: string; yaleAffiliation: string; gradYear: string };
type Ctx = {
  firstName: string; orgName: string; todayIso: string;
  trainingDate: string; trainingLocation: string;
  department: string | null; track: Track; epicRequirement: EpicRequirement;
  storedEpicId: string | null;
};

export function OnboardForm({
  token, prefill, layout, ctx, departments = [],
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

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setSubmitting(true);
    try {
      const res = await submitOnboarding(token, new FormData(e.currentTarget));
      setResult(res);
    } catch {
      // A blob/DB failure inside submitContract would otherwise re-throw and
      // freeze the button on "Submitting..." with no feedback. Surface a
      // retryable error and always re-enable submit.
      setResult({ ok: false, message: "Something went wrong submitting your onboarding. Please try again." });
    } finally {
      setSubmitting(false);
    }
  }

  if (result?.ok) {
    return <NextStepsScreen steps={result.nextSteps} />;
  }

  const err = (k: string) => (result && !result.ok ? result.fieldErrors?.[k] : undefined);

  // Client-side visibility mirrors the server: both call visibleOnboardingBlocks,
  // the same helper the builder preview uses, so the two can never diverge. It
  // handles both the enabled/core filter (dropping optional system fields a
  // director turned off entirely) and the visibleWhen evaluation against the
  // applicant's answers merged with the authoritative context.
  const shown = visibleOnboardingBlocks(layout, answers, {
    department: ctx.department, track: ctx.track, epicRequirement: ctx.epicRequirement,
    storedEpicId: ctx.storedEpicId,
  });

  return (
    <form onSubmit={onSubmit} className="mt-6">
      <Card className="space-y-6">
        {result && !result.ok && <Alert tone="error">{result.message}</Alert>}

        {shown.map((b) => (
          <ContractField
            key={"id" in b ? b.id : b.kind === "system_field" ? b.systemKey : b.key}
            block={b} prefill={prefill} ctx={ctx} err={err} onAnswer={onAnswer} departments={departments}
          />
        ))}

        <FormActions>
          <SubmitButton disabled={submitting}>{submitting ? "Submitting..." : "Submit onboarding"}</SubmitButton>
        </FormActions>
      </Card>
    </form>
  );
}
