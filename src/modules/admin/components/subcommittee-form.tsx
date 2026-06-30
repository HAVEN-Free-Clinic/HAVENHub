import type { Subcommittee } from "@prisma/client";
import { Input, Field } from "@/platform/ui/input";
import { Button } from "@/platform/ui/button";
import { Checkbox } from "@/platform/ui/checkbox";
import { Alert } from "@/platform/ui/alert";
import { Card } from "@/platform/ui/card";
import { FormActions } from "@/platform/ui/form";

type SubcommitteeFormProps = {
  action: (formData: FormData) => Promise<void>;
  mode: "create" | "edit";
  subcommittee?: Pick<Subcommittee, "name" | "isActive" | "order">;
  error?: string;
  saved?: string;
};

/** Create/edit form for a Subcommittee. Soft-delete via the Active toggle. */
export function SubcommitteeForm({ action, mode, subcommittee, error, saved }: SubcommitteeFormProps) {
  return (
    <form action={action}>
      <Card className="space-y-6">
      {error && <Alert tone="error">{error}</Alert>}
      {saved && <Alert tone="success">Changes saved.</Alert>}

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Name">
          <Input name="name" defaultValue={subcommittee?.name ?? ""} required placeholder="Community Outreach" />
        </Field>
        <Field label="Order" hint="Lower shows first. Optional.">
          <Input name="order" type="number" min="0" defaultValue={String(subcommittee?.order ?? 0)} />
        </Field>
      </div>

      <label className="flex items-center gap-2 text-sm">
        <Checkbox name="isActive" defaultChecked={subcommittee?.isActive ?? true} />
        Active
      </label>

      <FormActions>
        <Button type="submit" variant="primary">
          {mode === "create" ? "Create subcommittee" : "Save changes"}
        </Button>
      </FormActions>
      </Card>
    </form>
  );
}
