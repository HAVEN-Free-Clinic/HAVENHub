"use client";

/**
 * Recipient picker for forwarding an incident report or an issued strike to
 * clinical supervisors outside the clinic.
 *
 * Shared by the report detail page and the strikes ledger, which is why the
 * target field is parameterised (`targetIdName`) rather than hardcoded to a
 * report: both surfaces send the same shape to their own server action.
 *
 * Client component for one reason: the submit button stays disabled until at
 * least one recipient is checked. The server re-validates the recipient list
 * against the directory regardless -- this only stops a reviewer submitting an
 * empty form and getting bounced back with an error they could have been spared.
 *
 * Deliberately NOT a free-text address field. Every recipient is a checkbox over
 * the configured directory, because a typed address is one keystroke away from
 * disclosing an incident report to a stranger, and no send outside the
 * organization can be recalled.
 */

import { useState } from "react";
import { Checkbox } from "@/platform/ui/checkbox";
import { Field, Textarea } from "@/platform/ui/input";
import { SubmitButton } from "@/platform/ui/submit-button";
import { FormActions } from "@/platform/ui/form";

export type ForwardContact = { name: string | null; email: string };

type ForwardFormProps = {
  action: (formData: FormData) => Promise<void>;
  /** Form field name the owning action reads the target id from. */
  targetIdName: string;
  targetId: string;
  contacts: ForwardContact[];
};

export function ForwardForm({ action, targetIdName, targetId, contacts }: ForwardFormProps) {
  const [chosen, setChosen] = useState<string[]>([]);

  function toggle(email: string, checked: boolean) {
    setChosen((prev) => (checked ? [...prev, email] : prev.filter((e) => e !== email)));
  }

  return (
    <form action={action} className="mt-3 space-y-3">
      <input type="hidden" name={targetIdName} value={targetId} />

      <fieldset>
        <legend className="mb-2 text-sm font-medium">Send to</legend>
        <div className="space-y-1">
          {contacts.map((c) => (
            <label key={c.email} className="flex items-start gap-2 text-sm">
              <Checkbox
                name="emails"
                value={c.email}
                className="mt-0.5"
                checked={chosen.includes(c.email)}
                onChange={(e) => toggle(c.email, e.target.checked)}
              />
              <span>
                {c.name ? (
                  <>
                    <span className="font-medium">{c.name}</span>{" "}
                    <span className="text-subtle-foreground">({c.email})</span>
                  </>
                ) : (
                  c.email
                )}
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      <Field label="Note (optional)" hint="Included in the email and kept on the record">
        <Textarea name="note" rows={2} placeholder="Why you are sending this" />
      </Field>

      <FormActions>
        <SubmitButton disabled={chosen.length === 0}>
          {chosen.length > 1 ? `Forward to ${chosen.length} people` : "Forward"}
        </SubmitButton>
      </FormActions>
    </form>
  );
}
