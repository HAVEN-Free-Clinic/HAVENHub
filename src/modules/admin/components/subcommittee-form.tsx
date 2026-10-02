import type { Subcommittee } from "@prisma/client";
import { Input, Field, Textarea } from "@/platform/ui/input";
import { Checkbox } from "@/platform/ui/checkbox";
import { Card } from "@/platform/ui/card";
import { FormActions } from "@/platform/ui/form";
import { SubmitButton } from "@/platform/ui/submit-button";

type SubcommitteeFormProps = {
  action: (formData: FormData) => Promise<void>;
  mode: "create" | "edit";
  subcommittee?: Pick<
    Subcommittee,
    "name" | "isActive" | "order" | "description" | "capacity" | "signupOpen"
  >;
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

        <Field label="Description" hint="Shown to volunteers on the sign-up page. What does this subcommittee do, and what is the time commitment?">
          <Textarea name="description" rows={3} defaultValue={subcommittee?.description ?? ""} />
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Capacity" hint="Most volunteers who can sign up. Leads do not count. Leave blank for no limit.">
            <Input name="capacity" type="number" min="1" defaultValue={subcommittee?.capacity != null ? String(subcommittee.capacity) : ""} />
          </Field>
        </div>

        <Checkbox
          name="signupOpen"
          defaultChecked={subcommittee?.signupOpen ?? false}
          label="Sign-up open"
          hint="Volunteers can join or leave this subcommittee from My info. Staff can add people either way."
        />

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
