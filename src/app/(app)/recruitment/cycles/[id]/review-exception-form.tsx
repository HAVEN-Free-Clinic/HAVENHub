"use client";

import { useActionState, useState } from "react";
import { Alert } from "@/platform/ui/alert";
import { Combobox } from "@/platform/ui/combobox";
import { Field, Textarea } from "@/platform/ui/input";
import { SubmitButton } from "@/platform/ui/submit-button";

export type ReviewExceptionState = { error?: string; ok?: string } | null;

/**
 * Grants one person a review exception for this cycle: a name picker and the
 * reason, which the service requires. Submit stays disabled until both are
 * filled, so the refusal for a missing reason is a fallback, not the UX.
 */
export function ReviewExceptionForm({
  action,
  candidates,
}: {
  action: (prev: ReviewExceptionState, formData: FormData) => Promise<ReviewExceptionState>;
  candidates: { id: string; name: string }[];
}) {
  const [state, formAction] = useActionState(action, null);
  const [picked, setPicked] = useState("");
  const [reason, setReason] = useState("");
  return (
    <form action={formAction} className="space-y-3">
      {state?.error && <Alert tone="error">{state.error}</Alert>}
      {state?.ok && <Alert tone="success">{state.ok}</Alert>}
      <Combobox
        name="personId"
        ariaLabel="Search people to grant a review exception to"
        placeholder="Search people…"
        options={candidates.map((c) => ({ value: c.id, label: c.name }))}
        onValueChange={setPicked}
      />
      <Field label="Reason" hint="For example, the logistical need within their department, and that their ED approved it.">
        <Textarea name="reason" rows={2} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} required />
      </Field>
      <SubmitButton size="sm" pendingLabel="Granting…" disabled={!picked || reason.trim() === ""}>
        Grant exception
      </SubmitButton>
    </form>
  );
}
