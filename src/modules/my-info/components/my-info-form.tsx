/**
 * MyInfoForm: editable contact fields for the signed-in member.
 *
 * Editable: phone, contactEmail, yaleAffiliation, gradYear.
 * Read-only display rows: name, netId, epicId (IT-managed; not self-service).
 *
 * Accepts a server action so the parent page owns the action closure
 * (and the session/auth check lives there).
 */

import type { Person } from "@prisma/client";
import { Input, Field, ReadonlyField } from "@/platform/ui/input";
import { Select } from "@/platform/ui/select";
import { SubmitButton } from "@/platform/ui/submit-button";
import { Alert } from "@/platform/ui/alert";
import { Card } from "@/platform/ui/card";
import { FormActions } from "@/platform/ui/form";

const YALE_AFFILIATIONS = [
  "Yale College",
  "Yale School of Medicine",
  "Yale School of Nursing",
  "Yale School of Public Health",
  "Physician Associate Program",
  "Graduate School",
  "Staff",
  "Other",
] as const;

type MyInfoFormProps = {
  action: (formData: FormData) => Promise<void>;
  person: Pick<
    Person,
    | "name"
    | "netId"
    | "contactEmail"
    | "phone"
    | "epicId"
    | "yaleAffiliation"
    | "gradYear"
  >;
  error?: string;
  saved?: string;
};

export function MyInfoForm({ action, person, error, saved }: MyInfoFormProps) {
  const currentAffiliation = person.yaleAffiliation ?? "";
  const isKnownAffiliation = YALE_AFFILIATIONS.includes(
    currentAffiliation as (typeof YALE_AFFILIATIONS)[number]
  );

  return (
    <form action={action}>
      <Card className="space-y-6">
        {error && <Alert tone="error">{error}</Alert>}
        {saved && <Alert tone="success">{saved}</Alert>}

        {/* Read-only identity rows (IT-managed) */}
        <div className="grid gap-4 sm:grid-cols-2">
          <ReadonlyField label="Name" value={person.name} />
          <ReadonlyField
            label="NetID"
            value={person.netId}
            hint="Contact the IT team to correct your name or NetID."
          />
          <ReadonlyField
            label="Epic ID"
            value={person.epicId}
            hint="Contact the IT team to update your Epic ID."
          />
        </div>

        {/* Editable fields */}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Phone">
            <Input
              name="phone"
              type="tel"
              defaultValue={person.phone ?? ""}
              placeholder="203-555-0100"
            />
          </Field>

          <Field label="Email">
            <Input
              name="contactEmail"
              type="email"
              defaultValue={person.contactEmail ?? ""}
              placeholder="you@example.com"
            />
          </Field>

          <Field label="Yale Affiliation">
            <Select name="yaleAffiliation" defaultValue={currentAffiliation}>
              <option value="">Not set</option>
              {YALE_AFFILIATIONS.map((aff) => (
                <option key={aff} value={aff}>
                  {aff}
                </option>
              ))}
              {currentAffiliation && !isKnownAffiliation && (
                <option value={currentAffiliation}>{currentAffiliation}</option>
              )}
            </Select>
          </Field>

          <Field label="Grad Year">
            <Input
              name="gradYear"
              defaultValue={person.gradYear ?? ""}
              placeholder="2027"
              inputMode="numeric"
              maxLength={4}
              pattern="\d{4}"
            />
          </Field>
        </div>

        <FormActions>
          <SubmitButton variant="primary" pendingLabel="Saving…">
            Save
          </SubmitButton>
        </FormActions>
      </Card>
    </form>
  );
}
