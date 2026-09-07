"use client";

import { useState } from "react";
import { Button } from "@/platform/ui/button";
import { Modal } from "@/platform/ui/modal";
import { Field, Textarea } from "@/platform/ui/input";
import { SubmitButton } from "@/platform/ui/submit-button";

/**
 * Opens the reason form for excusing one person's training absence.
 *
 * A modal rather than an inline cell form: the reason is a sentence out of an
 * email, and a text box wide enough to read it does not fit in a roster row.
 *
 * The form posts straight to the bound server action, which redirects, so there
 * is no local success or error state to keep -- the page reloads and the flash
 * toast reports the outcome. Closing is therefore only ever the user cancelling.
 */
export function ExcuseAbsenceButton({
  name,
  currentReason,
  action,
}: {
  name: string;
  /** The reason already on file, if this is an edit rather than a first excuse. */
  currentReason: string | null;
  /** excuseAbsenceAction, already bound to its cycle and person. */
  action: (formData: FormData) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)}>
        {currentReason ? "Edit excuse" : "Excuse"}
      </Button>
      {open && (
        <Modal open onClose={() => setOpen(false)} title={`Excuse ${name} from training`}>
          <form action={action} className="space-y-4">
            <Field label="Reason" hint="What they told you. Paste the line from their email." required>
              <Textarea name="reason" rows={4} defaultValue={currentReason ?? ""} required />
            </Field>
            <p className="text-sm text-foreground-soft">
              This records the absence as excused. It does not complete training: they still
              need the makeup quiz.
            </p>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <SubmitButton size="sm" pendingLabel="Saving…">
                Save excuse
              </SubmitButton>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}
