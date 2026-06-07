/**
 * PersonForm: server component rendering fields for creating/editing a Person.
 *
 * Accepts a server action prop so it can be reused for both create and update.
 * Error and saved strings come from searchParams so the server can redirect
 * back with inline feedback.
 */

import type { Person } from "@prisma/client";
import type { ReactNode } from "react";
import { Input, Field } from "@/platform/ui/input";
import { Button } from "@/platform/ui/button";

type PersonFormProps = {
  /** The server action to bind to the form's action prop. */
  action: (formData: FormData) => Promise<void>;
  /** Existing person values (for edit mode). Omit for create mode. */
  person?: Pick<
    Person,
    | "name"
    | "netId"
    | "contactEmail"
    | "yaleEmail"
    | "phone"
    | "epicId"
    | "yaleAffiliation"
    | "gradYear"
  >;
  /** Error string to display (e.g. "netId already belongs to another person"). */
  error?: string;
  /** Shown when the save was successful. */
  saved?: string;
  /** Extra content to render after the submit button (e.g. status actions). */
  children?: ReactNode;
};

export function PersonForm({ action, person, error, saved, children }: PersonFormProps) {
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
        <Field label="Full Name">
          <Input
            name="name"
            defaultValue={person?.name ?? ""}
            required
            placeholder="Jane Smith"
          />
        </Field>

        <Field label="NetID">
          <Input
            name="netId"
            defaultValue={person?.netId ?? ""}
            placeholder="jds234"
          />
        </Field>

        <Field label="Contact Email">
          <Input
            name="contactEmail"
            type="email"
            defaultValue={person?.contactEmail ?? ""}
            placeholder="jane.smith@example.com"
          />
        </Field>

        <Field label="Yale Email">
          <Input
            name="yaleEmail"
            type="email"
            defaultValue={person?.yaleEmail ?? ""}
            placeholder="jane.smith@yale.edu"
          />
        </Field>

        <Field label="Phone">
          <Input
            name="phone"
            type="tel"
            defaultValue={person?.phone ?? ""}
            placeholder="203-555-0100"
          />
        </Field>

        <Field label="Epic ID">
          <Input
            name="epicId"
            defaultValue={person?.epicId ?? ""}
            placeholder="E12345"
          />
        </Field>

        <Field label="Yale Affiliation">
          <Input
            name="yaleAffiliation"
            defaultValue={person?.yaleAffiliation ?? ""}
            placeholder="Medical Student"
          />
        </Field>

        <Field label="Grad Year">
          <Input
            name="gradYear"
            defaultValue={person?.gradYear ?? ""}
            placeholder="2027"
          />
        </Field>
      </div>

      <div className="flex items-center gap-3 pt-2">
        <Button type="submit" variant="primary">
          Save
        </Button>
        {children}
      </div>
    </form>
  );
}
