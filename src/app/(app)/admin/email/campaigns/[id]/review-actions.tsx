"use client";

import { useEffect, useState } from "react";
import { Input, Field } from "@/platform/ui/input";
import { Alert } from "@/platform/ui/alert";
import { SubmitButton } from "./submit-button";

type FormAction = (formData: FormData) => void | Promise<void>;

/**
 * Preview / Test / Send controls for a draft campaign.
 *
 * These actions run against the last SAVED campaign (audience + body read from
 * the database), so acting on unsaved compose/audience edits would preview or
 * send to a stale audience. To prevent that silent mismatch we watch the compose
 * form for edits and, while it is dirty, disable the actions and show a notice
 * telling the admin to save first. A successful save reloads the page, which
 * remounts this component with a clean (not-dirty) state.
 */
export function ReviewActions({
  formId,
  previewAction,
  testAction,
  sendAction,
}: {
  formId: string;
  previewAction: FormAction;
  testAction: FormAction;
  sendAction: FormAction;
}) {
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    const form = document.getElementById(formId);
    if (!form) return;

    const markDirty = () => setDirty(true);
    const onClick = (event: Event) => {
      // Structural edits (add/remove audience condition, match toggle, rich-text
      // toolbar, variable-insert chips) happen via type="button" controls and
      // fire no input/change event, so catch them here.
      const target = event.target as HTMLElement | null;
      if (target?.closest('button[type="button"]')) setDirty(true);
    };

    form.addEventListener("input", markDirty);
    form.addEventListener("change", markDirty);
    form.addEventListener("click", onClick);
    return () => {
      form.removeEventListener("input", markDirty);
      form.removeEventListener("change", markDirty);
      form.removeEventListener("click", onClick);
    };
  }, [formId]);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-3">
        {/* Preview audience */}
        <form action={previewAction}>
          <SubmitButton variant="outline" pendingLabel="Previewing..." disabled={dirty}>
            Preview audience
          </SubmitButton>
        </form>

        {/* Test send */}
        <form action={testAction}>
          <SubmitButton variant="outline" pendingLabel="Sending test..." disabled={dirty}>
            Send test to me
          </SubmitButton>
        </form>

        {/* Live send */}
        <form action={sendAction} className="flex items-end gap-2">
          <Field label="Confirm count (required for >25 recipients)">
            <Input
              name="confirmCount"
              type="number"
              min={1}
              placeholder="e.g. 42"
              className="w-24"
            />
          </Field>
          <SubmitButton variant="danger" pendingLabel="Sending..." disabled={dirty}>
            Send now
          </SubmitButton>
        </form>
      </div>

      {dirty && (
        <Alert tone="warning">
          Save your changes before previewing or sending. These actions use the last
          saved version of this campaign.
        </Alert>
      )}
    </div>
  );
}
