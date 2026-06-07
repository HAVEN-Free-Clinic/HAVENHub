/**
 * TermForm: server component rendering fields for creating a Term.
 *
 * Accepts a server action prop. Error strings come from searchParams so the
 * server can redirect back with inline feedback.
 */

import type { Term } from "@prisma/client";
import { Input, Field } from "@/platform/ui/input";
import { Button } from "@/platform/ui/button";

function toDateInputValue(d: Date): string {
  // Return YYYY-MM-DD in UTC for the date input default value.
  return d.toISOString().slice(0, 10);
}

type TermFormProps = {
  /** The server action to bind to the form's action prop. */
  action: (formData: FormData) => Promise<void>;
  /** Existing term values (for edit mode). Omit for create mode. */
  term?: Pick<Term, "code" | "name" | "startDate" | "endDate">;
  /** Error string to display (e.g. conflict message). */
  error?: string;
  /** Shown when the save was successful. */
  saved?: string;
};

export function TermForm({ action, term, error, saved }: TermFormProps) {
  return (
    <form action={action} className="space-y-6">
      {error && (
        <p
          role="alert"
          className="rounded-md border border-critical/20 bg-red-50 px-3 py-2 text-sm text-critical"
        >
          {error}
        </p>
      )}
      {saved && (
        <p className="text-sm text-success">{saved}</p>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Code" hint="E.g. FA26. Will be uppercased automatically.">
          <Input
            name="code"
            defaultValue={term?.code ?? ""}
            required
            placeholder="FA26"
          />
        </Field>

        <Field label="Name">
          <Input
            name="name"
            defaultValue={term?.name ?? ""}
            required
            placeholder="Fall 2026"
          />
        </Field>

        <Field label="Start date">
          <Input
            name="startDate"
            type="date"
            defaultValue={term ? toDateInputValue(term.startDate) : ""}
            required
          />
        </Field>

        <Field label="End date">
          <Input
            name="endDate"
            type="date"
            defaultValue={term ? toDateInputValue(term.endDate) : ""}
            required
          />
        </Field>
      </div>

      <div className="flex items-center gap-3 pt-2">
        <Button type="submit" variant="primary">
          Create term
        </Button>
      </div>
    </form>
  );
}
