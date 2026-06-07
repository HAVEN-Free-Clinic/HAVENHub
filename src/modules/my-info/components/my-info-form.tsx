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
import { Input, Field } from "@/platform/ui/input";
import { Select } from "@/platform/ui/select";
import { Button } from "@/platform/ui/button";

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

      {/* Read-only identity rows */}
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-1">
          <span className="text-xs font-medium text-slate-500">Name</span>
          <p className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700">
            {person.name || <span className="italic text-slate-400">Not set</span>}
          </p>
        </div>

        <div className="flex flex-col gap-1">
          <span className="text-xs font-medium text-slate-500">NetID</span>
          <p className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700">
            {person.netId || <span className="italic text-slate-400">Not set</span>}
          </p>
          <p className="text-xs text-slate-400">
            Contact the IT team to correct your name or NetID.
          </p>
        </div>

        <div className="flex flex-col gap-1">
          <span className="text-xs font-medium text-slate-500">Epic ID</span>
          <p className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700">
            {person.epicId || <span className="italic text-slate-400">Not set</span>}
          </p>
          <p className="text-xs text-slate-400">
            Contact the IT team to update your Epic ID.
          </p>
        </div>
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

        <Field label="Contact Email">
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
            {/* If the stored value isn't in the list, show it as a selectable option */}
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
          />
        </Field>
      </div>

      <div className="pt-2">
        <Button type="submit" variant="primary">
          Save
        </Button>
      </div>
    </form>
  );
}
