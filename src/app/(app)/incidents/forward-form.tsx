"use client";

/**
 * Forwarding an incident report or an issued strike to a clinical advisor
 * outside the clinic.
 *
 * A PLAIN EMAIL FIELD, on purpose. These advisors are third parties: no Hub
 * account, no Person record, nothing to grant a permission to and nothing to
 * pre-register them against. An earlier version of this made the reviewer pick
 * from a settings-managed directory, which put an admin step between them and
 * the advisor they needed to reach.
 *
 * Addresses used before are offered through a <datalist>, so the common case
 * (the same two or three advisors, over and over) is a pick rather than a
 * retype, while an address never used before still just works. A datalist and
 * not a <select>: it suggests without constraining.
 *
 * Client component because the submit button stays disabled until the field
 * holds something that looks like an address. The service re-validates and is
 * the real guard; this only spares the reviewer a round trip.
 */

import { useId, useState } from "react";
import { Field, Input, Textarea } from "@/platform/ui/input";
import { SubmitButton } from "@/platform/ui/submit-button";
import { FormActions } from "@/platform/ui/form";

type ForwardFormProps = {
  action: (formData: FormData) => Promise<void>;
  /** Form field name the owning action reads the target id from. */
  targetIdName: string;
  targetId: string;
  /** Previously used addresses, offered as suggestions. */
  suggestions?: string[];
};

/** Mirrors the service's check. Permissive by design: it catches "not an
 *  address at all", not undeliverable ones. */
const LOOKS_LIKE_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function ForwardForm({ action, targetIdName, targetId, suggestions = [] }: ForwardFormProps) {
  const [email, setEmail] = useState("");
  const listId = useId();

  return (
    <form action={action} className="mt-3 space-y-3">
      <input type="hidden" name={targetIdName} value={targetId} />

      <div className="max-w-md">
        <Field label="Forward to" hint="Email address of the advisor outside the clinic">
          <Input
            name="emails"
            type="email"
            list={suggestions.length > 0 ? listId : undefined}
            placeholder="advisor@example.org"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="off"
          />
        </Field>
        {suggestions.length > 0 && (
          <datalist id={listId}>
            {suggestions.map((s) => (
              <option key={s} value={s} />
            ))}
          </datalist>
        )}
      </div>

      <div className="max-w-md">
        <Field label="Note (optional)" hint="Included in the email and kept on the record">
          <Textarea name="note" rows={2} placeholder="Why you are sending this" />
        </Field>
      </div>

      <FormActions>
        <SubmitButton disabled={!LOOKS_LIKE_EMAIL.test(email.trim())}>Forward</SubmitButton>
      </FormActions>
    </form>
  );
}
