import type { ComponentProps } from "react";
import { Card } from "@/platform/ui/card";
import { FormActions } from "@/platform/ui/form";
import { SubmitButton } from "@/platform/ui/submit-button";
import { TemplateEditor } from "@/app/(app)/admin/email/templates/[key]/preview";

/**
 * The save frame around an email template editor.
 *
 * Two pages edit a stored template and were framing the same editor
 * differently: the admin template page carded it and submitted through
 * SubmitButton, while the recruitment cycle-email page left it uncarded and
 * submitted both Save and Reset through a plain Button.
 *
 * That last part is a defect rather than drift. A plain Button has no pending
 * state, so saving a template on the cycle page gave no feedback across the
 * server round trip and stayed clickable throughout, which is how a slow save
 * gets submitted twice. SubmitButton disables itself and shows a Spinner while
 * the action is in flight.
 *
 * Only the two STANDALONE template pages use this. The outreach campaign
 * composer also renders TemplateEditor, but as one section of a larger tabbed
 * form with a single save for the whole campaign; it has no save frame of its
 * own to share and is deliberately left alone.
 */
export function TemplateEditorForm({
  saveAction,
  resetAction,
  hasOverride,
  saveLabel = "Save",
  ...editor
}: {
  /** Server action. Takes FormData because the editor posts subject and body. */
  saveAction: (formData: FormData) => Promise<void>;
  /** Omit to render no reset control at all. */
  resetAction?: (formData: FormData) => Promise<void>;
  /** Whether a stored override exists to reset back to the built-in default. */
  hasOverride: boolean;
  saveLabel?: string;
} & ComponentProps<typeof TemplateEditor>) {
  return (
    <>
      <form action={saveAction}>
        <Card className="space-y-6">
          <TemplateEditor {...editor} />
          <FormActions>
            <SubmitButton pendingLabel="Saving…">{saveLabel}</SubmitButton>
          </FormActions>
        </Card>
      </form>

      {resetAction && hasOverride && (
        <form action={resetAction}>
          <SubmitButton variant="outline" pendingLabel="Resetting…">
            Reset to default
          </SubmitButton>
        </form>
      )}
    </>
  );
}
