"use client";

import { useActionState } from "react";
import { Alert } from "@/platform/ui/alert";
import { Field, Textarea } from "@/platform/ui/input";
import { Select } from "@/platform/ui/select";
import { SubmitButton } from "@/platform/ui/submit-button";
import type { BulkAddResult } from "@/modules/admin/services/subcommittee-members";

function names(list: string[]): string {
  return list.length <= 5 ? list.join(", ") : `${list.slice(0, 5).join(", ")} and ${list.length - 5} more`;
}

/**
 * Paste NetIDs or emails, pick a role, add. How the director list goes in.
 * Anyone already on the subcommittee is set to the chosen role, so pasting the
 * leads as LEAD after they signed up as members promotes them.
 */
export function AddMembersForm({
  action,
}: {
  action: (prev: BulkAddResult | null, formData: FormData) => Promise<BulkAddResult | null>;
}) {
  const [result, formAction] = useActionState(action, null);
  return (
    <form action={formAction} className="space-y-3">
      <Field
        label="Add people"
        hint="NetIDs or email addresses, one per line or separated by commas. Matched against people already in the Hub."
      >
        <Textarea name="identifiers" rows={4} placeholder={"abc123\njane.doe@yale.edu"} />
      </Field>
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Role">
          <Select name="role" defaultValue="LEAD" className="w-auto">
            <option value="LEAD">Lead</option>
            <option value="MEMBER">Member</option>
          </Select>
        </Field>
        <SubmitButton pendingLabel="Adding…">Add</SubmitButton>
      </div>
      {result && (
        <div className="space-y-2" aria-live="polite">
          {(result.added.length > 0 || result.updated.length > 0 || result.unchanged.length > 0) && (
            <Alert tone="success">
              {result.added.length > 0 && <>Added {names(result.added)}. </>}
              {result.updated.length > 0 && <>Changed the role of {names(result.updated)}. </>}
              {result.unchanged.length > 0 && <>Already on it: {names(result.unchanged)}.</>}
            </Alert>
          )}
          {result.notFound.length > 0 && (
            <Alert tone="warning">
              No one in the Hub matches {result.notFound.join(", ")}. Check the spelling, or add
              them to the Hub first.
            </Alert>
          )}
        </div>
      )}
    </form>
  );
}
