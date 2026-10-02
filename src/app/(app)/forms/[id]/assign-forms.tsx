"use client";

import { useActionState } from "react";
import { Alert } from "@/platform/ui/alert";
import { Checkbox } from "@/platform/ui/checkbox";
import { Field, Textarea } from "@/platform/ui/input";
import { SubmitButton } from "@/platform/ui/submit-button";
import { AudienceBuilder } from "@/app/(app)/outreach/campaigns/[id]/audience-builder";
import type { Audience } from "@/platform/email/audience/types";
import type { AssignState } from "./actions";

type AssignAction = (prev: AssignState, formData: FormData) => Promise<AssignState>;

function Outcome({ state }: { state: AssignState }) {
  if (!state) return null;
  if ("error" in state && state.error) return <Alert tone="error">{state.error}</Alert>;
  if (!("added" in state)) return null;
  return (
    <div className="space-y-2" aria-live="polite">
      <Alert tone="success">
        Assigned {state.added} {state.added === 1 ? "person" : "people"}
        {state.alreadyAssigned > 0 && ` (${state.alreadyAssigned} already had it)`}
        {state.emailed > 0 && `, and emailed ${state.emailed}`}.
      </Alert>
      {state.notFound.length > 0 && (
        <Alert tone="warning">No one in the Hub matches {state.notFound.join(", ")}.</Alert>
      )}
    </div>
  );
}

function NotifyBox({ open }: { open: boolean }) {
  return (
    <Checkbox
      name="notify"
      defaultChecked={open}
      disabled={!open}
      label="Email the people I add a link to the form"
      hint={open ? "Only people newly assigned are emailed." : "Open the form first to email people about it."}
    />
  );
}

/** Assign by an audience, with the same condition builder Outreach uses. */
export function AssignAudienceForm({
  action,
  countAction,
  open,
  options,
}: {
  action: AssignAction;
  countAction: (audience: Audience) => Promise<Record<string, number>>;
  open: boolean;
  options: Omit<React.ComponentProps<typeof AudienceBuilder>, "initial" | "countAction">;
}) {
  const [state, formAction] = useActionState(action, null);
  return (
    <form action={formAction} className="space-y-4">
      <AudienceBuilder
        {...options}
        initial={{ recordType: "PERSON", match: "ALL", conditions: [] }}
        countAction={countAction}
      />
      <NotifyBox open={open} />
      <SubmitButton pendingLabel="Assigning…">Assign to this audience</SubmitButton>
      <Outcome state={state} />
    </form>
  );
}

/** Assign by a pasted list of NetIDs or emails. */
export function AssignListForm({ action, open }: { action: AssignAction; open: boolean }) {
  const [state, formAction] = useActionState(action, null);
  return (
    <form action={formAction} className="space-y-3">
      <Field label="NetIDs or emails" hint="One per line, or separated by commas.">
        <Textarea name="identifiers" rows={4} placeholder={"abc123\njane.doe@yale.edu"} />
      </Field>
      <NotifyBox open={open} />
      <SubmitButton pendingLabel="Assigning…">Assign</SubmitButton>
      <Outcome state={state} />
    </form>
  );
}
