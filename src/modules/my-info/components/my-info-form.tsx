/**
 * MyInfoForm: editable contact fields for the signed-in member.
 *
 * Editable: preferredFirstName, phone, contactEmail, yaleAffiliation, gradYear.
 * Read-only display rows: legal name, netId, epicId (IT-managed; not self-service).
 *
 * The name split: a member owns what they GO BY, and IT owns their legal name,
 * because that is what reaches YNHH on an Epic request and the signed contract.
 *
 * Accepts a server action so the parent page owns the action closure
 * (and the session/auth check lives there).
 */

import type { Person } from "@prisma/client";
import { Input, Field, ReadonlyField } from "@/platform/ui/input";
import { Select } from "@/platform/ui/select";
import { SubmitButton } from "@/platform/ui/submit-button";
import { Card } from "@/platform/ui/card";
import { FormActions } from "@/platform/ui/form";
import { affiliationOptionsWith } from "@/platform/affiliation";
import { legalNameOf } from "@/platform/person-name";

type MyInfoFormProps = {
  action: (formData: FormData) => Promise<void>;
  person: Pick<
    Person,
    | "name"
    | "legalFirstName"
    | "legalMiddleName"
    | "lastName"
    | "preferredFirstName"
    | "netId"
    | "contactEmail"
    | "phone"
    | "epicId"
    | "yaleAffiliation"
    | "gradYear"
    | "dateOfBirth"
    | "dietaryRestrictions"
  >;
  /** Onboarding uses this shared form for the "profile" step, which only clears
   *  once BOTH phone and contactEmail are present. When true, require them so the
   *  step can't be submitted blank and silently re-loop on the checklist. */
  requireContact?: boolean;
};

export function MyInfoForm({ action, person, requireContact }: MyInfoFormProps) {
  const currentAffiliation = person.yaleAffiliation ?? "";
  const affiliationOptions = affiliationOptionsWith(currentAffiliation);

  return (
    <form action={action}>
      <Card className="space-y-6">
        {/* Read-only identity rows (IT-managed) */}
        <div className="grid gap-4 sm:grid-cols-2">
          <ReadonlyField
            label="Legal name"
            value={legalNameOf(person)}
            hint="Used for your Epic account and your signed contract."
          />
          <ReadonlyField
            label="NetID"
            value={person.netId}
            hint="Contact the IT team to correct your legal name or NetID."
          />
          <ReadonlyField
            label="Epic ID"
            value={person.epicId}
            hint="Contact the IT team to update your Epic ID."
          />
          <ReadonlyField
            label="Date of Birth"
            value={person.dateOfBirth ? new Date(person.dateOfBirth).toISOString().slice(0, 10) : null}
            hint="Set during onboarding; contact the IT team to correct it."
          />
        </div>

        {/* Editable fields */}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Goes by"
            hint="The name used on rosters, badges, and every email we send you. Leave blank to use your legal first name."
          >
            <Input
              name="preferredFirstName"
              defaultValue={person.preferredFirstName ?? ""}
              placeholder={person.legalFirstName}
            />
          </Field>

          <Field label="Phone" required={requireContact}>
            <Input
              name="phone"
              type="tel"
              required={requireContact}
              defaultValue={person.phone ?? ""}
              placeholder="203-555-0100"
            />
          </Field>

          <Field label="Email" required={requireContact}>
            <Input
              name="contactEmail"
              type="email"
              required={requireContact}
              defaultValue={person.contactEmail ?? ""}
              placeholder="you@example.com"
            />
          </Field>

          <Field label="Yale affiliation">
            <Select name="yaleAffiliation" defaultValue={currentAffiliation}>
              <option value="">Not set</option>
              {affiliationOptions.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="Grad year">
            <Input
              name="gradYear"
              defaultValue={person.gradYear ?? ""}
              placeholder="2027"
              inputMode="numeric"
              maxLength={4}
              pattern="\d{4}"
            />
          </Field>

          <Field label="Dietary restrictions" hint="For orientation and event catering. Leave blank if none.">
            <Input
              name="dietaryRestrictions"
              defaultValue={person.dietaryRestrictions ?? ""}
              placeholder="e.g. vegetarian, nut allergy"
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
