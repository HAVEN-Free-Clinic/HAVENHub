/**
 * TermForm: server component rendering fields for creating a Term.
 *
 * Accepts a server action prop. Error strings come from searchParams so the
 * server can redirect back with inline feedback.
 */

import type { Term } from "@prisma/client";
import { Input, Field } from "@/platform/ui/input";
import { Card } from "@/platform/ui/card";
import { FormActions } from "@/platform/ui/form";
import { SubmitButton } from "@/platform/ui/submit-button";

function toDateInputValue(d: Date): string {
  // Return YYYY-MM-DD in UTC for the date input default value.
  return d.toISOString().slice(0, 10);
}

type TermFormProps = {
  /** The server action to bind to the form's action prop. */
  action: (formData: FormData) => Promise<void>;
  /** Which verb the submit takes, and nothing else. Same shape as the other
   *  record forms in this module. */
  mode: "create" | "edit";
  /** Existing term values (for edit mode). Omit for create mode. */
  term?: Pick<Term, "code" | "name" | "startDate" | "endDate">;
};

export function TermForm({ action, mode, term }: TermFormProps) {
  return (
    <form action={action}>
      <Card className="space-y-6">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Code" required hint="E.g. FA26. Will be uppercased automatically.">
            <Input
              name="code"
              defaultValue={term?.code ?? ""}
              required
              placeholder="FA26"
            />
          </Field>

          <Field label="Name" required>
            <Input
              name="name"
              defaultValue={term?.name ?? ""}
              required
              placeholder="Fall 2026"
            />
          </Field>

          <Field label="Start date" required>
            <Input
              name="startDate"
              type="date"
              defaultValue={term ? toDateInputValue(term.startDate) : ""}
              required
            />
          </Field>

          <Field label="End date" required>
            <Input
              name="endDate"
              type="date"
              defaultValue={term ? toDateInputValue(term.endDate) : ""}
              required
            />
          </Field>
        </div>

        <FormActions>
          <SubmitButton variant="primary">
            {mode === "create" ? "Create term" : "Save changes"}
          </SubmitButton>
        </FormActions>
      </Card>
    </form>
  );
}
