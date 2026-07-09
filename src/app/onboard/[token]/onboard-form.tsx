"use client";
import { useState } from "react";
import { submitOnboarding, type SubmitResult } from "./actions";
import { ContractField } from "./contract-field";
import { Alert } from "@/platform/ui/alert";
import { SubmitButton } from "@/platform/ui/submit-button";
import { Card } from "@/platform/ui/card";
import { FormActions } from "@/platform/ui/form";
import { SYSTEM_FIELDS } from "@/modules/recruitment/contract/system-fields";
import type { ContractLayout } from "@/modules/recruitment/contract/layout";

type Prefill = { firstName: string; lastName: string; email: string; netId: string; phone: string };
type Ctx = { firstName: string; orgName: string };

export function OnboardForm({
  token, prefill, layout, ctx,
}: { token: string; prefill: Prefill; layout: ContractLayout; ctx: Ctx }) {
  const [result, setResult] = useState<SubmitResult | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setSubmitting(true);
    const res = await submitOnboarding(token, new FormData(e.currentTarget));
    setResult(res);
    setSubmitting(false);
  }

  if (result?.ok) {
    return <Alert tone="success" className="mt-8">Thanks, your onboarding is complete. We will be in touch with next steps.</Alert>;
  }

  const err = (k: string) => (result && !result.ok ? result.fieldErrors?.[k] : undefined);

  return (
    <form onSubmit={onSubmit} className="mt-6">
      <Card className="space-y-6">
        {result && !result.ok && <Alert tone="error">{result.message}</Alert>}

        {layout.blocks
          .filter((b) => b.kind !== "system_field" || b.enabled !== false || SYSTEM_FIELDS[b.systemKey].core)
          .map((b, i) => <ContractField key={i} block={b} prefill={prefill} ctx={ctx} err={err} />)}

        <FormActions>
          <SubmitButton disabled={submitting}>{submitting ? "Submitting..." : "Submit onboarding"}</SubmitButton>
        </FormActions>
      </Card>
    </form>
  );
}
