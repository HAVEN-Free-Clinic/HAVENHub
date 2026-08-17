"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Input, Textarea } from "@/platform/ui/input";
import { Checkbox } from "@/platform/ui/checkbox";
import { Alert } from "@/platform/ui/alert";
import { SubmitButton } from "@/platform/ui/submit-button";
import { runAction } from "@/platform/ui/run-action";
import type { TriageChatDraft } from "@/modules/schedule/services/triage-chat-draft";
import { createTriageChatAction } from "../../actions";

export function ReviewForm({
  draft,
  disabled,
}: {
  draft: TriageChatDraft;
  disabled: boolean;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  // Group for display by the same department name the roster block uses, so the
  // list on screen and the list in the message read the same way.
  const groups = new Map<string, typeof draft.resolved>();
  for (const entry of draft.resolved) {
    const key = entry.member.departmentName;
    groups.set(key, [...(groups.get(key) ?? []), entry]);
  }

  async function onSubmit(formData: FormData) {
    const result = await runAction(() => createTriageChatAction(draft.preset.id, formData));
    if (result.error) {
      setError(result.error);
      return;
    }
    setError(null);
    startTransition(() =>
      router.push(`/schedule/triage-chats/${draft.preset.id}/created`),
    );
  }

  return (
    <form action={onSubmit} className="space-y-5">
      {error && <Alert tone="error">{error}</Alert>}
      {draft.warnings.map((warning) => (
        <Alert key={warning} tone="warning">
          {warning}
        </Alert>
      ))}

      {/*
        The clinic week this screen was built for. The confirm re-resolves the
        roster with a fresh now, so a page opened on Saturday and submitted on
        Sunday would otherwise create next week's chat carrying this week's name,
        text, and ticked checkboxes.
      */}
      <input type="hidden" name="clinicDateKey" value={draft.clinicDateKey} />

      <label className="block space-y-1">
        <span className="text-sm font-medium">Chat name</span>
        <Input name="topic" defaultValue={draft.topic} required />
      </label>

      <fieldset className="space-y-3">
        <legend className="text-sm font-medium">
          Members ({draft.resolved.filter((r) => r.userId).length} can be added)
        </legend>
        {[...groups.entries()].map(([department, entries]) => (
          <div key={department} className="space-y-1">
            <p className="text-sm font-semibold">{department}</p>
            {entries.map((entry) => {
              const unresolved = !entry.userId;
              return (
                <label
                  key={entry.member.personId}
                  className="flex items-start gap-2 text-sm"
                >
                  <Checkbox
                    name="includePersonIds"
                    value={entry.member.personId}
                    defaultChecked={!unresolved}
                    disabled={unresolved}
                  />
                  <span>
                    {entry.member.name}
                    {unresolved && (
                      <span className="block text-xs text-muted-foreground">
                        Cannot be added automatically: {entry.reason}
                      </span>
                    )}
                  </span>
                </label>
              );
            })}
          </div>
        ))}
      </fieldset>

      <label className="block space-y-1">
        <span className="text-sm font-medium">Opening message</span>
        <Textarea name="messageBody" defaultValue={draft.messageBody} rows={16} required />
      </label>

      <SubmitButton pendingLabel="Creating..." disabled={disabled}>
        Create chat and post message
      </SubmitButton>
    </form>
  );
}
