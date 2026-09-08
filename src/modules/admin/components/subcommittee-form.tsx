import type { Subcommittee } from "@prisma/client";
import { Input, Field } from "@/platform/ui/input";
import { Checkbox } from "@/platform/ui/checkbox";
import { Card } from "@/platform/ui/card";
import { FormActions } from "@/platform/ui/form";
import { SubmitButton } from "@/platform/ui/submit-button";

type SubcommitteeFormProps = {
  action: (formData: FormData) => Promise<void>;
  mode: "create" | "edit";
  subcommittee?: Pick<Subcommittee, "name" | "isActive" | "order">;
};

/** Create/edit form for a Subcommittee. Soft-delete via the Active toggle. */
export function SubcommitteeForm({ action, mode, subcommittee }: SubcommitteeFormProps) {
  return (
    <form action={action}>
      <Card className="space-y-6">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name" required>
            <Input name="name" defaultValue={subcommittee?.name ?? ""} required placeholder="Community Outreach" />
          </Field>
          <Field label="Order" hint="Lower shows first. Optional.">
            <Input name="order" type="number" min="0" defaultValue={String(subcommittee?.order ?? 0)} />
          </Field>
        </div>

        <Checkbox
          name="isActive"
          defaultChecked={subcommittee?.isActive ?? true}
          label="Active"
          hint="Clearing this is the soft remove: the subcommittee stops being offered, and its history stays."
        />

        <FormActions>
          <SubmitButton variant="primary">
            {mode === "create" ? "Create subcommittee" : "Save changes"}
          </SubmitButton>
        </FormActions>
      </Card>
    </form>
  );
}
