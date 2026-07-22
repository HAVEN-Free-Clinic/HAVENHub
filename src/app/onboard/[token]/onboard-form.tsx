"use client";
import { useCallback, useState } from "react";
import type { EpicRequirement, Track } from "@prisma/client";
import { submitOnboarding, type SubmitResult } from "./actions";
import { ContractField } from "./contract-field";
import { Alert } from "@/platform/ui/alert";
import { SubmitButton } from "@/platform/ui/submit-button";
import { Card } from "@/platform/ui/card";
import { FormActions } from "@/platform/ui/form";
import { SYSTEM_FIELDS } from "@/modules/recruitment/contract/system-fields";
import { buildContractAnswers, visibleContractBlocks } from "@/modules/recruitment/contract/visibility";
import type { ContractLayout } from "@/modules/recruitment/contract/layout";

type Prefill = { firstName: string; lastName: string; email: string; netId: string; phone: string; yaleAffiliation: string; gradYear: string };
type Ctx = {
  firstName: string; orgName: string; todayIso: string; currentYear: number;
  trainingDate: string; trainingLocation: string;
  department: string | null; track: Track; epicRequirement: EpicRequirement;
};

export function OnboardForm({
  token, prefill, layout, ctx,
}: { token: string; prefill: Prefill; layout: ContractLayout; ctx: Ctx }) {
  const [result, setResult] = useState<SubmitResult | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // Free-form answers the applicant has entered so far (selects, checkboxes,
  // custom questions). Merged with the authoritative server context below via
  // buildContractAnswers before every visibility check, so a hostile or stale
  // form field of the same name can never override department/track/Epic
  // requirement.
  //
  // Seeded from prefill on first render, mirroring apply-wizard.tsx's answers
  // seeding: several fields (yaleAffiliation, gradYear, netId, phone) render
  // with defaultValue and never fire onChange on mount, so without this seed
  // a prefilled value that gates another block (e.g. staffTitle's
  // visibleWhen on yaleAffiliation === "staff") would evaluate against an
  // empty answers map on the first render and hide a block the applicant
  // never gets a chance to answer. department/track/epicRequirement are
  // deliberately NOT seeded here: they are authoritative context that
  // buildContractAnswers strips out of formAnswers and overrides from ctx on
  // every call, so seeding them would do nothing except be misleading.
  const [answers, setAnswers] = useState<Record<string, string | string[]>>(() => {
    const seed: Record<string, string | string[]> = {};
    if (prefill.yaleAffiliation) seed.yaleAffiliation = prefill.yaleAffiliation;
    if (prefill.gradYear) seed.gradYear = prefill.gradYear;
    if (prefill.netId) seed.netId = prefill.netId;
    if (prefill.phone) seed.phone = prefill.phone;
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
    return <Alert tone="success" className="mt-8">Thanks, your onboarding is complete. We will be in touch with next steps.</Alert>;
  }

  const err = (k: string) => (result && !result.ok ? result.fieldErrors?.[k] : undefined);

  // Client-side visibility mirrors the server: build the answers map through
  // the same buildContractAnswers/visibleContractBlocks pair the submit path
  // (Task 14) uses, so the two can never diverge. The enabled/core filter is
  // separate: it drops optional system fields a director turned off entirely,
  // which visibleWhen conditions do not model.
  const resolved = buildContractAnswers(answers, {
    department: ctx.department, track: ctx.track, epicRequirement: ctx.epicRequirement,
  });
  const enabled = layout.blocks.filter(
    (b) => b.kind !== "system_field" || b.enabled !== false || SYSTEM_FIELDS[b.systemKey].core,
  );
  const shown = visibleContractBlocks(enabled, resolved);

  return (
    <form onSubmit={onSubmit} className="mt-6">
      <Card className="space-y-6">
        {result && !result.ok && <Alert tone="error">{result.message}</Alert>}

        {shown.map((b) => (
          <ContractField
            key={"id" in b ? b.id : b.kind === "system_field" ? b.systemKey : b.key}
            block={b} prefill={prefill} ctx={ctx} err={err} onAnswer={onAnswer}
          />
        ))}

        <FormActions>
          <SubmitButton disabled={submitting}>{submitting ? "Submitting..." : "Submit onboarding"}</SubmitButton>
        </FormActions>
      </Card>
    </form>
  );
}
