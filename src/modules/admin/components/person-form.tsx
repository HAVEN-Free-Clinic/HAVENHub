/**
 * PersonForm: server component rendering fields for creating/editing a Person.
 *
 * Accepts a server action prop so it can be reused for both create and update.
 */

import type { Person } from "@prisma/client";
import type { ReactNode } from "react";
import { Input, Field } from "@/platform/ui/input";
import { Button } from "@/platform/ui/button";
import { Checkbox } from "@/platform/ui/checkbox";
import { Card } from "@/platform/ui/card";
import { FormActions } from "@/platform/ui/form";
import { Select } from "@/platform/ui/select";
import { affiliationOptionsWith } from "@/platform/affiliation";

type PersonFormProps = {
  /** The server action to bind to the form's action prop. */
  action: (formData: FormData) => Promise<void>;
  /** Existing person values (for edit mode). Omit for create mode. */
  person?: Pick<
    Person,
    | "name"
    | "netId"
    | "contactEmail"
    | "phone"
    | "epicId"
    | "yaleAffiliation"
    | "gradYear"
    | "licensedRN"
  >;
  /** Extra content to render after the submit button (e.g. status actions). */
  children?: ReactNode;
};

export function PersonForm({ action, person, children }: PersonFormProps) {
  return (
    <form action={action}>
      <Card className="space-y-6">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Full Name" required>
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

          <Field label="Email">
            <Input
              name="contactEmail"
              type="email"
              defaultValue={person?.contactEmail ?? ""}
              placeholder="jane.smith@example.com"
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
            <Select name="yaleAffiliation" defaultValue={person?.yaleAffiliation ?? ""}>
              <option value="">Not set</option>
              {affiliationOptionsWith(person?.yaleAffiliation).map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="Grad Year">
            <Input
              name="gradYear"
              defaultValue={person?.gradYear ?? ""}
              placeholder="2027"
            />
          </Field>
        </div>

        <div className="space-y-4">
          <div className="flex flex-wrap gap-6">
            <label className="flex items-center gap-2 text-sm text-foreground-soft">
              <Checkbox
                name="licensedRN"
                defaultChecked={person?.licensedRN ?? false}
              />
              Licensed RN
            </label>
          </div>
          {/* Languages are no longer edited here. They live in PersonLanguage,
              one row per language, and are assessed through the interpreting
              department's review queue, which stamps who assessed and when.
              A free checkbox on this form would be an unattributed override of
              that assessment. */}
          <p className="text-xs text-subtle-foreground">
            Language capabilities are recorded and verified in Volunteers &gt; Language review.
          </p>
        </div>

        <FormActions>
          <Button type="submit" variant="primary">
            Save
          </Button>
          {children}
        </FormActions>
      </Card>
    </form>
  );
}
