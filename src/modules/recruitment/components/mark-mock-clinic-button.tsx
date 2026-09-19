"use client";

import { useState } from "react";
import { Button } from "@/platform/ui/button";
import { Modal } from "@/platform/ui/modal";
import { Field, Textarea } from "@/platform/ui/input";
import { SubmitButton } from "@/platform/ui/submit-button";

/**
 * IT's mark-off for a member who missed mock clinic.
 *
 * The note is required and is the record: who confirmed the make-up (or the
 * waiver) and when. Same modal shape as ExcuseAbsenceButton, for the same
 * reason: the note is a sentence, and a roster cell has no room for one.
 */
export function MarkMockClinicButton({
  name,
  action,
}: {
  name: string;
  /** markMockClinicDoneAction, already bound to its cycle and person. */
  action: (formData: FormData) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)}>
        Mark mock clinic done
      </Button>
      {open && (
        <Modal open onClose={() => setOpen(false)} title={`Mark mock clinic done for ${name}`}>
          <form action={action} className="space-y-4">
            <Field
              label="Note"
              hint="Who confirmed it and when, e.g. 'Made up with the PNLC director on 10/1' or 'Waived by the ICDD director'."
              required
            >
              <Textarea name="note" rows={3} required />
            </Field>
            <p className="text-sm text-foreground-soft">
              This counts as their mock clinic without adding them to the attendance list, which
              keeps showing only who was there.
            </p>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <SubmitButton size="sm" pendingLabel="Saving…">
                Mark done
              </SubmitButton>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}
