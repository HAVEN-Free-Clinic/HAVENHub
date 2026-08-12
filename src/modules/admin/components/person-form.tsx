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
import { DateOnly } from "@/platform/dates/display";
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
    | "spanishSelfReported"
    | "spanishVerified"
    | "spanishVerifiedAt"
    | "licensedRN"
    | "blockerGateExempt"
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
                name="spanishSelfReported"
                defaultChecked={person?.spanishSelfReported ?? false}
              />
              Spanish-speaking (self-reported)
            </label>
            <label className="flex items-center gap-2 text-sm text-foreground-soft">
              <Checkbox
                name="licensedRN"
                defaultChecked={person?.licensedRN ?? false}
              />
              Licensed RN
            </label>
          </div>
          <div className="flex flex-col gap-1">
            <label className="flex items-center gap-2 text-sm text-foreground-soft">
              <Checkbox
                name="spanishVerified"
                defaultChecked={person?.spanishVerified ?? false}
              />
              Spanish verified (interpreting dept)
            </label>
            {person?.spanishVerifiedAt && (
              <p className="text-xs text-subtle-foreground">
                Verified on <DateOnly value={new Date(person.spanishVerifiedAt)} />
              </p>
            )}
          </div>
          <div className="flex flex-col gap-1">
            <label className="flex items-center gap-2 text-sm text-foreground-soft">
              <Checkbox
                name="blockerGateExempt"
                defaultChecked={person?.blockerGateExempt ?? false}
              />
              Skip the content blocker check
            </label>
            <p className="text-xs text-subtle-foreground">
              This person can use the hub without turning off their content blocker.
              Support may not reach them, so use this for people on a managed device or
              network they cannot change themselves.
            </p>
          </div>
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
