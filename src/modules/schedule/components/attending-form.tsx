/**
 * AttendingForm: server component for creating/editing an RhdAttending.
 * Bound to a server action; capabilities are yes/no/unknown selects.
 */

import type { RhdAttending } from "@prisma/client";
import { Alert } from "@/platform/ui/alert";
import { Card } from "@/platform/ui/card";
import { Checkbox } from "@/platform/ui/checkbox";
import { FormActions } from "@/platform/ui/form";
import { Input, Field } from "@/platform/ui/input";
import { Select } from "@/platform/ui/select";
import { Button } from "@/platform/ui/button";
import { CAPABILITY_KEYS, CAPABILITY_LABELS } from "@/modules/schedule/services/attendings";

type AttendingFormProps = {
  action: (formData: FormData) => Promise<void>;
  attending?: RhdAttending;
  error?: string;
};

export function AttendingForm({ action, attending, error }: AttendingFormProps) {
  return (
    <form action={action}>
      <Card className="space-y-6">
        {error && <Alert tone="error">{error}</Alert>}
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
