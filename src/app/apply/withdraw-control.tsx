"use client";

import { useActionState } from "react";
import { Alert } from "@/platform/ui/alert";
import { ConfirmButton } from "@/platform/ui/confirm-button";
import type { ApplicantStatusView } from "@/modules/recruitment/services/portal-status";
import { withdrawApplicationAction, discardDraftAction, type WithdrawActionState } from "./portal-actions";

/** Copy for each control, keyed by the server-computed withdraw kind. */
const CONTROL = {
  discard_draft: { label: "Discard draft", confirm: "Discard? This deletes your answers and any files." },
  withdraw: { label: "Withdraw application", confirm: "Withdraw? We will stop considering you this cycle." },
  decline_offer: { label: "Decline offer", confirm: "Decline this offer?" },
} as const;

const INITIAL_STATE: WithdrawActionState = { error: null };

/**
 * The two-click destructive control, rendered only when the server said so.
 * Eligibility lives in portal-status; this component never decides it.
 *
 * A client component (not the plain <form action={...}> the server-rendered
 * card used before) because it needs useActionState to read back the result:
 * a refusal (already withdrawn, promoted, raced) must tell the applicant why,
 * not just silently change the card's shape. The Alert renders inside THIS
 * card, which is why useActionState is used instead of a `?error=` search
 * param -- an applicant can have several application cards on /apply at once,
 * and a URL param cannot say which card's action failed.
 */
export function WithdrawControl({ app }: { app: ApplicantStatusView }) {
  const boundAction = (app.withdraw?.kind === "discard_draft" ? discardDraftAction : withdrawApplicationAction).bind(
    null,
    app.slug,
  );
  // Hooks run unconditionally on every render, so useActionState is called
  // before the `if (!app.withdraw)` bailout below, even when there is nothing
  // to render this time.
  const [state, formAction] = useActionState(boundAction, INITIAL_STATE);

  if (!app.withdraw) return null;
  const { label, confirm } = CONTROL[app.withdraw.kind];

  return (
    <div className="mt-3 space-y-2 border-t border-border-subtle pt-3">
      {state.error && <Alert tone="error">{state.error}</Alert>}
      <form action={formAction} className="flex justify-end">
        <ConfirmButton label={label} confirmLabel={confirm} size="sm" />
      </form>
    </div>
  );
}
