/**
 * AttendingForm: server component for adding or editing an attending.
 *
 * Bound to a server action. The qualification matrix is whatever the chosen
 * specialty asks, which for most attendings is nothing at all -- a primary care
 * attending has no IUD qualification, and asking would imply a gap rather than
 * an inapplicable question.
 */

import type { Attending } from "@prisma/client";
import { Card } from "@/platform/ui/card";
import { Checkbox } from "@/platform/ui/checkbox";
import { FormActions } from "@/platform/ui/form";
import { Input, Field } from "@/platform/ui/input";
import { Select } from "@/platform/ui/select";
import { Button } from "@/platform/ui/button";
import type {
  Capability,
  CapabilityValue,
  SpecialtyView,
} from "@/modules/schedule/services/attendings";

type AttendingFormProps = {
  action: (formData: FormData) => Promise<void>;
  attending?: Attending;
  specialties: SpecialtyView[];
  selectedSpecialtyId: string | null;
  /**
   * The questions this attending's specialty asks, in order. Empty is normal,
   * and renders no matrix.
   *
   * Fields are named by capability ID, not key, so the server can reject an id
   * that does not belong to the specialty without guessing what a key meant.
   */
  capabilities: Capability[];
  /** Capability id -> stored answer. A missing id renders as "unknown". */
  values?: Record<string, CapabilityValue>;
};

export function AttendingForm({
  action,
  attending,
  specialties,
  selectedSpecialtyId,
  capabilities,
  values,
}: AttendingFormProps) {
  return (
    <form action={action}>
      <Card className="space-y-6">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Schedule name"
            required
            hint="How the schedule and reminder email name them, e.g. Peggy Bia."
          >
            <Input name="scheduleName" defaultValue={attending?.scheduleName ?? ""} required placeholder="Peggy Bia" />
          </Field>
          <Field label="Full name" required hint="As the roster records it, e.g. Bia, Margaret.">
            <Input name="fullName" defaultValue={attending?.fullName ?? ""} required placeholder="Bia, Margaret" />
          </Field>
          <Field label="Credentials">
            <Input name="credentials" defaultValue={attending?.credentials ?? ""} placeholder="MD, MPH" />
          </Field>
          <Field label="Specialty" hint="Determines which qualifications are asked below.">
            <Select name="specialtyId" defaultValue={selectedSpecialtyId ?? ""}>
              <option value="">-- not set --</option>
              {specialties.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Email">
            <Input name="email" type="email" defaultValue={attending?.email ?? ""} placeholder="name@yale.edu" />
          </Field>
          <Field label="Phone">
            <Input name="phone" defaultValue={attending?.phone ?? ""} placeholder="203 555 0123" />
          </Field>
        </div>

        {capabilities.length > 0 && (
          <div className="space-y-2">
            <p className="text-sm font-medium text-foreground">Qualifications</p>
            <div className="grid gap-4 sm:grid-cols-3">
              {capabilities.map((c) => (
                <Field key={c.id} label={c.label}>
                  <Select name={`capability:${c.id}`} defaultValue={values?.[c.id] ?? "unknown"}>
                    <option value="yes">yes</option>
                    <option value="no">no</option>
                    <option value="unknown">unknown</option>
                  </Select>
                </Field>
              ))}
            </div>
            {/* Changing the specialty changes which questions apply, and the
                form does not re-render until save. Say so rather than letting
                the matrix look stale. */}
            <p className="text-xs text-muted-foreground">
              These are the qualifications for the specialty saved on this attending. Change the
              specialty and save to see that specialty&rsquo;s questions.
            </p>
          </div>
        )}

        <Field label="Notes">
          <Input name="notes" defaultValue={attending?.notes ?? ""} placeholder="Optional" />
        </Field>

        {attending !== undefined && (
          <label className="flex items-center gap-2 text-sm text-foreground-soft">
            <Checkbox name="isActive" defaultChecked={attending.isActive} />
            Active
          </label>
        )}

        <FormActions>
          <Button type="submit" variant="primary">Save</Button>
        </FormActions>
      </Card>
    </form>
  );
}
