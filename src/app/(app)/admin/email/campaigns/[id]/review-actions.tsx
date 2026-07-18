"use client";

import { useState } from "react";
import { Input, Field } from "@/platform/ui/input";
import { Alert } from "@/platform/ui/alert";
import { Button } from "@/platform/ui/button";
import { SubmitButton } from "./submit-button";
import { useFormDirty } from "./use-form-dirty";

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
  const dirty = useFormDirty(formId);
  // "Send now" arms on the first click and only sends on the second, so even a
  // small audience (25 or fewer, where no typed count is required) gets an
  // explicit confirmation before real email is dispatched.
  const [armed, setArmed] = useState(false);

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
          {armed ? (
            <SubmitButton variant="danger" pendingLabel="Sending..." disabled={dirty}>
              Confirm send
            </SubmitButton>
          ) : (
            <Button
              type="button"
              variant="danger"
              disabled={dirty}
              onClick={() => setArmed(true)}
            >
              Send now
            </Button>
          )}
        </form>
      </div>

      {armed && !dirty && (
        <Alert tone="warning">
          Click Confirm send to dispatch this campaign to real recipients. This cannot be undone.
        </Alert>
      )}

      {dirty && (
        <Alert tone="warning">
          Save your changes before previewing or sending. These actions use the last
          saved version of this campaign.
        </Alert>
      )}
    </div>
  );
}
