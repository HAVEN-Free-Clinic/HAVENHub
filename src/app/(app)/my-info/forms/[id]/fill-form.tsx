"use client";

import { useActionState } from "react";
import { Alert } from "@/platform/ui/alert";
import { SubmitButton } from "@/platform/ui/submit-button";
import { FormRenderer } from "@/modules/forms/components/form-renderer";
import type { Answers, FormLayout } from "@/modules/forms/layout";
import type { SubmitState } from "./actions";

export function FillForm({
  layout,
  initial,
  action,
  submitLabel,
}: {
  layout: FormLayout;
  initial: Answers;
  action: (prev: SubmitState, formData: FormData) => Promise<SubmitState>;
  submitLabel: string;
}) {
  const [state, formAction] = useActionState(action, null);
  return (
    <form action={formAction} className="space-y-6">
      <FormRenderer layout={layout} initial={initial} />
      {state && (
        <Alert tone="error">
          {state.problems.length === 1 ? (
            state.problems[0]
          ) : (
            <ul className="list-disc pl-5">
              {state.problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          )}
        </Alert>
      )}
      <SubmitButton pendingLabel="Submitting…">{submitLabel}</SubmitButton>
    </form>
  );
}
