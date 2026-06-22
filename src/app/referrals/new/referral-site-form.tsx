"use client";

import { useState } from "react";
import { Plus, X } from "lucide-react";
import { Field, Input, Textarea } from "@/platform/ui/input";
import { Button } from "@/platform/ui/button";

const CATEGORIES = [
  { value: "COMMUNITY_HEALTH", label: "Community health" },
  { value: "CARDIOLOGY", label: "Cardiology" },
  { value: "ENDOCRINOLOGY", label: "Endocrinology" },
  { value: "GASTROENTEROLOGY", label: "Gastroenterology" },
  { value: "BEHAVIORAL_HEALTH", label: "Behavioral health" },
  { value: "OBGYN", label: "OB-GYN" },
  { value: "ORTHOPEDICS", label: "Orthopedics" },
  { value: "DERMATOLOGY", label: "Dermatology" },
  { value: "PULMONOLOGY", label: "Pulmonology" },
  { value: "NEUROLOGY", label: "Neurology" },
  { value: "OPHTHALMOLOGY", label: "Ophthalmology" },
  { value: "ENT", label: "ENT" },
  { value: "DENTAL", label: "Dental" },
  { value: "SOCIAL_SERVICES", label: "Social services" },
];

const SYSTEMS = [
  { value: "YNHH", label: "YNHH" },
  { value: "COMMUNITY_HC", label: "Community HC" },
  { value: "COMMUNITY_NONPROFIT", label: "Community nonprofit" },
  { value: "STATE_RESOURCE_HUB", label: "State resource hub" },
  { value: "NONPROFIT_LEGAL_AID", label: "Nonprofit legal aid" },
];

const FLAGS = [
  { value: "", label: "None" },
  { value: "SUCCESS", label: "Success (e.g. graduation partner)" },
  { value: "WARN", label: "Warning (e.g. coordinate Free Care first)" },
  { value: "INFO", label: "Info (e.g. special routing note)" },
];

type ProviderRow = { id: string; name: string; specialty: string };

type InitialValues = {
  name: string;
  category: string;
  specialty: string;
  system: string | null;
  acceptsUninsured: boolean;
  freeCareEligible: boolean;
  slidingScale: boolean;
  waitWeeks: number | null;
  waitNote: string | null;
  phone: string | null;
  address: string;
  languages: string[];
  schedulingContact: string | null;
  fax: string | null;
  referralSteps: string[];
  notes: string | null;
  flag: string | null;
  flagText: string | null;
  providers: { name: string; specialty: string }[];
};

export function ReferralSiteForm({
  action,
  initialValues,
  submitLabel = "Add provider",
}: {
  action: (formData: FormData) => Promise<void>;
  initialValues?: InitialValues;
  submitLabel?: string;
}) {
  const [submitting, setSubmitting] = useState(false);
  const [providerRows, setProviderRows] = useState<ProviderRow[]>(
    initialValues?.providers.length
      ? initialValues.providers.map((p) => ({ id: crypto.randomUUID(), ...p }))
      : [{ id: crypto.randomUUID(), name: "", specialty: "" }]
  );

  function addRow() {
    setProviderRows((rows) => [...rows, { id: crypto.randomUUID(), name: "", specialty: "" }]);
  }

  function removeRow(id: string) {
    setProviderRows((rows) => rows.filter((r) => r.id !== id));
  }

  function updateRow(id: string, field: "name" | "specialty", value: string) {
    setProviderRows((rows) => rows.map((r) => (r.id === id ? { ...r, [field]: value } : r)));
  }

  return (
    <form
      action={action}
      onSubmit={() => setSubmitting(true)}
      className="space-y-6 rounded-2xl border border-border bg-surface p-6 shadow-sm"
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Provider / site name">
          <Input name="name" required defaultValue={initialValues?.name} placeholder="Fair Haven Community Health" />
        </Field>

        <Field label="Specialty">
          <Input name="specialty" required defaultValue={initialValues?.specialty} placeholder="Primary care · Dental · Behavioral health" />
        </Field>

        <Field label="Category">
          <select name="category" required defaultValue={initialValues?.category} className="rounded-lg border border-border-strong px-3 py-2 text-sm w-full">
            {CATEGORIES.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
        </Field>

        <Field label="System">
          <select name="system" required defaultValue={initialValues?.system ?? ""} className="rounded-lg border border-border-strong px-3 py-2 text-sm w-full">
            {SYSTEMS.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Phone">
          <Input name="phone" required defaultValue={initialValues?.phone ?? ""} placeholder="(203) 777-7411" />
        </Field>

        <Field label="Fax" hint="Optional">
          <Input name="fax" defaultValue={initialValues?.fax ?? ""} placeholder="(203) 777-7412" />
        </Field>

        <Field label="Address">
          <Input name="address" required defaultValue={initialValues?.address} placeholder="374 Grand Ave, New Haven CT 06513" />
        </Field>

        <Field label="Scheduling contact">
          <Input name="schedulingContact" required defaultValue={initialValues?.schedulingContact ?? ""} placeholder="Main line → ask for patient registration" />
        </Field>

        <Field label="Languages" hint="Comma-separated">
          <Input name="languages" defaultValue={initialValues?.languages.join(", ") ?? ""} placeholder="English, Spanish, Haitian Creole" />
        </Field>

        <Field label="Typical wait (weeks)" hint="Leave blank if unknown">
          <Input name="waitWeeks" type="number" min={0} defaultValue={initialValues?.waitWeeks ?? ""} placeholder="2" />
        </Field>
      </div>

      <Field label="Wait note" hint="Optional context on timing">
        <Input name="waitNote" defaultValue={initialValues?.waitNote ?? ""} placeholder="Same-week urgent slots often available" />
      </Field>

      <div className="flex flex-wrap gap-6">
        <label className="flex items-center gap-2 text-sm text-foreground-soft">
          <input type="checkbox" name="acceptsUninsured" defaultChecked={initialValues?.acceptsUninsured} className="h-4 w-4 rounded accent-brand" />
          Accepts uninsured
        </label>
        <label className="flex items-center gap-2 text-sm text-foreground-soft">
          <input type="checkbox" name="freeCareEligible" defaultChecked={initialValues?.freeCareEligible} className="h-4 w-4 rounded accent-brand" />
          Free Care eligible
        </label>
        <label className="flex items-center gap-2 text-sm text-foreground-soft">
          <input type="checkbox" name="slidingScale" defaultChecked={initialValues?.slidingScale} className="h-4 w-4 rounded accent-brand" />
          Sliding scale
        </label>
      </div>

      <Field label="Referral steps" hint="One step per line">
        <Textarea
          name="referralSteps"
          rows={4}
          defaultValue={initialValues?.referralSteps.join("\n") ?? ""}
          placeholder={"Patient calls directly or HAVEN coordinator makes warm handoff call\nNo formal referral needed — walk-in welcome"}
        />
      </Field>

      <Field label="Volunteer note" hint="Optional context for whoever makes the referral">
        <Textarea name="notes" rows={3} defaultValue={initialValues?.notes ?? ""} placeholder="Our primary graduation partner..." />
      </Field>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Flag" hint="Optional callout shown on the provider's page">
          <select name="flag" defaultValue={initialValues?.flag ?? ""} className="rounded-lg border border-border-strong px-3 py-2 text-sm w-full">
            {FLAGS.map((f) => (
              <option key={f.value} value={f.value}>
                {f.label}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Flag text" hint="Required if a flag is selected">
          <Input name="flagText" defaultValue={initialValues?.flagText ?? ""} placeholder="Graduation partner — warm handoff preferred" />
        </Field>
      </div>

      <Field label="Referral steps" hint="One step per line">
        <Textarea
          name="referralSteps"
          rows={4}
          placeholder={"Patient calls directly or HAVEN coordinator makes warm handoff call\nNo formal referral needed — walk-in welcome"}
        />
      </Field>

      <Field label="Volunteer note" hint="Optional context for whoever makes the referral">
        <Textarea name="notes" rows={3} placeholder="Our primary graduation partner..." />
      </Field>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Flag" hint="Optional callout shown on the provider's page">
          <select name="flag" className="rounded-lg border border-border-strong px-3 py-2 text-sm w-full">
            {FLAGS.map((f) => (
              <option key={f.value} value={f.value}>
                {f.label}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Flag text" hint="Required if a flag is selected">
          <Input name="flagText" placeholder="Graduation partner — warm handoff preferred" />
        </Field>
      </div>

      {/* Providers at this location -- dynamic rows */}
      <div>
        <p className="text-xs font-medium text-muted-foreground mb-2">Providers at this location</p>
        <div className="space-y-2">
          {providerRows.map((row, i) => (
            <div key={row.id} className="flex gap-2 items-start">
              <input type="hidden" name={`provider_name_${i}`} value={row.name} />
              <input type="hidden" name={`provider_specialty_${i}`} value={row.specialty} />
              <Input
                placeholder="Dr. Maria Santos, MD"
                value={row.name}
                onChange={(e) => updateRow(row.id, "name", e.target.value)}
                className="flex-1"
              />
              <Input
                placeholder="Family medicine"
                value={row.specialty}
                onChange={(e) => updateRow(row.id, "specialty", e.target.value)}
                className="flex-1"
              />
              <button
                type="button"
                onClick={() => removeRow(row.id)}
                disabled={providerRows.length === 1}
                className="shrink-0 grid h-9 w-9 place-items-center rounded-lg border border-border-strong text-muted-foreground transition hover:bg-muted disabled:opacity-40"
                aria-label="Remove provider"
              >
                <X className="h-4 w-4" aria-hidden />
              </button>
            </div>
          ))}
        </div>
        <button
          type="button"
          onClick={addRow}
          className="mt-2 inline-flex items-center gap-2 text-sm font-medium text-brand-fg hover:underline"
        >
          <Plus className="h-4 w-4" aria-hidden />
          Add another provider
        </button>
        <input type="hidden" name="providerCount" value={providerRows.length} />
      </div>

      <div className="pt-2">
        <Button type="submit" disabled={submitting}>
          {submitting ? "Saving..." : submitLabel}
        </Button>
      </div>
    </form>
  );
}