/**
 * AttendingForm: server component for creating/editing an RhdAttending.
 * Bound to a server action; capabilities are yes/no/unknown selects.
 */

import type { RhdAttending } from "@prisma/client";
import { Input, Field } from "@/platform/ui/input";
import { Select } from "@/platform/ui/select";
import { Button } from "@/platform/ui/button";
import { CAPABILITY_KEYS } from "@/modules/schedule/services/attendings";

const CAPABILITY_LABELS: Record<(typeof CAPABILITY_KEYS)[number], string> = {
  iudIn: "IUD In",
  iudOut: "IUD Out",
  nexplanon: "Nexplanon",
  gac: "GAC",
  emb: "EMB",
  seesMale: "Sees Male",
};

type AttendingFormProps = {
  action: (formData: FormData) => Promise<void>;
  attending?: RhdAttending;
  error?: string;
};

export function AttendingForm({ action, attending, error }: AttendingFormProps) {
  return (
    <form action={action} className="space-y-6">
      {error && (
        <p role="alert" className="rounded-md border border-critical/20 bg-red-50 px-3 py-2 text-sm text-critical">
          {error}
        </p>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Schedule name">
          <Input name="scheduleName" defaultValue={attending?.scheduleName ?? ""} required placeholder="Rivera" />
        </Field>
        <Field label="Full name">
          <Input name="fullName" defaultValue={attending?.fullName ?? ""} required placeholder="Dr. Rivera" />
        </Field>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        {CAPABILITY_KEYS.map((key) => (
          <Field key={key} label={CAPABILITY_LABELS[key]}>
            <Select name={key} defaultValue={(attending?.[key] as string) ?? "unknown"}>
              <option value="yes">yes</option>
              <option value="no">no</option>
              <option value="unknown">unknown</option>
            </Select>
          </Field>
        ))}
      </div>

      <Field label="Notes">
        <Input name="notes" defaultValue={attending?.notes ?? ""} placeholder="Optional" />
      </Field>

      <label className="flex items-center gap-2 text-sm text-slate-700">
        <input type="checkbox" name="isActive" defaultChecked={attending?.isActive ?? true} className="h-4 w-4 rounded accent-brand" />
        Active
      </label>

      <Button type="submit" variant="primary">Save</Button>
    </form>
  );
}
