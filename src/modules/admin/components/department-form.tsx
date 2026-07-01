import type { Department } from "@prisma/client";
import { Input, Field } from "@/platform/ui/input";
import { Button } from "@/platform/ui/button";
import { Checkbox } from "@/platform/ui/checkbox";
import { Alert } from "@/platform/ui/alert";
import { Card } from "@/platform/ui/card";
import { FormActions } from "@/platform/ui/form";

type DepartmentFormProps = {
  action: (formData: FormData) => Promise<void>;
  mode: "create" | "edit";
  department?: Pick<Department, "code" | "name" | "isActive" | "idealHeadcount" | "patientCapacityPerProvider">;
  error?: string;
  saved?: string;
};

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

          <Field label="Name">
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
