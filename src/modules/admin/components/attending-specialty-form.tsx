import type { AttendingSpecialty } from "@prisma/client";
import { Input, Field } from "@/platform/ui/input";
import { SubmitButton } from "@/platform/ui/submit-button";
import { Checkbox } from "@/platform/ui/checkbox";
import { Card } from "@/platform/ui/card";
import { FormActions } from "@/platform/ui/form";

type AttendingSpecialtyFormProps = {
  action: (formData: FormData) => Promise<void>;
  mode: "create" | "edit";
  specialty?: Pick<AttendingSpecialty, "code" | "name" | "runsSpecialtyClinic" | "order">;
};

/**
 * Create/edit form for an AttendingSpecialty.
 *
 * Code is frozen after creation, the same as the department form. It reads like
 * a display abbreviation, but the roster importer matches the spreadsheet's free
 * text to a specialty through an alias table keyed on these exact codes
 * (platform/attendings/import/roster.ts), so renaming one there quietly stops
 * the importer recognising it. On edit the field renders read-only and the
 * action does not read it.
 */
export function AttendingSpecialtyForm({ action, mode, specialty }: AttendingSpecialtyFormProps) {
  return (
    <form action={action}>
      <Card className="space-y-6">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Code"
            required={mode === "create"}
            hint={
              mode === "create"
                ? "2-12 letters/digits, e.g. DERM. Uppercased automatically. Cannot be changed later."
                : "Fixed after creation: the attending roster import matches on this code."
            }
          >
            <Input
              name="code"
              defaultValue={specialty?.code ?? ""}
              required={mode === "create"}
              disabled={mode !== "create"}
              placeholder="DERM"
            />
          </Field>

          <Field label="Name" required>
            <Input name="name" defaultValue={specialty?.name ?? ""} required placeholder="Dermatology" />
          </Field>

          <Field label="Display order" hint="Lower shows first in the roster and schedule.">
            <Input name="order" type="number" step="1" defaultValue={String(specialty?.order ?? 0)} />
          </Field>
        </div>

        <div className="space-y-2">
          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              name="runsSpecialtyClinic"
              defaultChecked={specialty?.runsSpecialtyClinic ?? false}
            />
            Can run the rotating Specialty Clinic
          </label>
          <p className="text-xs text-muted-foreground">
            Tick this for a specialty that takes over a clinic date as that day&apos;s Specialty Clinic
            (Dermatology, Neurology, Nephrology). Leave it clear for a specialty that only describes
            where an attending works, such as Primary Care.
          </p>
        </div>

        <FormActions>
          <SubmitButton variant="primary">
            {mode === "create" ? "Create specialty" : "Save changes"}
          </SubmitButton>
        </FormActions>
      </Card>
    </form>
  );
}
