import type { Department, EpicRequirement } from "@prisma/client";
import { Input, Field } from "@/platform/ui/input";
import { Button } from "@/platform/ui/button";
import { Checkbox } from "@/platform/ui/checkbox";
import { Select } from "@/platform/ui/select";
import { Alert } from "@/platform/ui/alert";
import { Card } from "@/platform/ui/card";
import { FormActions } from "@/platform/ui/form";

type DepartmentFormProps = {
  action: (formData: FormData) => Promise<void>;
  mode: "create" | "edit";
  department?: Pick<
    Department,
    "code" | "name" | "isActive" | "idealHeadcount" | "patientCapacityPerProvider" | "requiresEpicDirector" | "requiresEpicVolunteer"
  >;
  error?: string;
  saved?: string;
};

/** Ordered least → most access; the value is the stored EpicRequirement enum. */
const EPIC_OPTIONS: { value: EpicRequirement; label: string }[] = [
  { value: "NONE", label: "Not required" },
  { value: "SOME", label: "Ask each applicant" },
  { value: "ALL", label: "Required for all" },
];

/** Create/edit form for a Department. Code is editable on create, read-only on edit. */
export function DepartmentForm({ action, mode, department, error, saved }: DepartmentFormProps) {
  return (
    <form action={action}>
      <Card className="space-y-6">
        {error && <Alert tone="error">{error}</Alert>}
        {saved && <Alert tone="success">Changes saved.</Alert>}

        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Code"
            required={mode === "create"}
            hint={mode === "edit" ? "Code cannot be changed after creation." : "2-12 letters/digits, e.g. SCTS. Uppercased automatically."}
          >
            <Input
              name="code"
              defaultValue={department?.code ?? ""}
              required={mode === "create"}
              disabled={mode === "edit"}
              placeholder="SCTS"
            />
          </Field>

          <Field label="Name" required>
            <Input name="name" defaultValue={department?.name ?? ""} required placeholder="Surgical Care Team" />
          </Field>

          <Field label="Ideal headcount" hint="Optional.">
            <Input name="idealHeadcount" type="number" min="1" defaultValue={String(department?.idealHeadcount ?? "")} />
          </Field>

          <Field label="Patient capacity per provider" hint="Optional.">
            <Input
              name="patientCapacityPerProvider"
              type="number"
              min="1"
              defaultValue={String(department?.patientCapacityPerProvider ?? "")}
            />
          </Field>
        </div>

        <div className="space-y-3">
          <div>
            <p className="text-sm font-medium text-foreground">Epic access requirement</p>
            <p className="text-xs text-muted-foreground">
              Controls the Epic section of the onboarding contract for this department. Required for all provisions
              Epic for everyone; Ask each applicant shows a per-person question; Not required hides the section
              (an applicant who already has an Epic ID on file is always asked to confirm it).
            </p>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Directors">
              <Select name="requiresEpicDirector" defaultValue={department?.requiresEpicDirector ?? "NONE"}>
                {EPIC_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Volunteers">
              <Select name="requiresEpicVolunteer" defaultValue={department?.requiresEpicVolunteer ?? "NONE"}>
                {EPIC_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
        </div>

        <label className="flex items-center gap-2 text-sm">
          <Checkbox name="isActive" defaultChecked={department?.isActive ?? true} />
          Active
        </label>

        <FormActions>
          <Button type="submit" variant="primary">
            {mode === "create" ? "Create department" : "Save changes"}
          </Button>
        </FormActions>
      </Card>
    </form>
  );
}
