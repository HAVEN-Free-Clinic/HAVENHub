import { requirePermission } from "@/platform/auth/session";
import { PageHeader } from "@/platform/ui/page-header";
import { Card } from "@/platform/ui/card";
import { Input, Textarea, Field } from "@/platform/ui/input";
import { Checkbox } from "@/platform/ui/checkbox";
import { Alert } from "@/platform/ui/alert";
import { FormActions } from "@/platform/ui/form";
import { SubmitButton } from "@/platform/ui/submit-button";
import { notFound } from "next/navigation";
import { getTrainingForEdit } from "@/platform/ehs/services/trainings";
import { updateTrainingAction } from "../actions";

export default async function EditEhsTrainingPage({
  params,
  searchParams,
}: {
  params: Promise<{ trainingId: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  await requirePermission("volunteers.manage_compliance");
  const { trainingId } = await params;
  const sp = await searchParams;
  const training = await getTrainingForEdit(trainingId);
  if (!training) notFound();

  return (
    <>
      <PageHeader title={`Edit: ${training.name}`} description="Edit this EHS training requirement." />
      <div className="mt-6 max-w-2xl">
        {sp.error && (
          <Alert tone="error">{decodeURIComponent(sp.error)}</Alert>
        )}
        <Card>
          <form action={updateTrainingAction}>
            <input type="hidden" name="trainingId" value={training.id} />
            <div className="space-y-4">
              <Field label="Name">
                <Input name="name" defaultValue={training.name} required />
              </Field>
              <Field label="Description">
                <Textarea
                  name="description"
                  defaultValue={training.description ?? ""}
                  placeholder="Description"
                />
              </Field>
              <label className="flex items-center gap-2 text-sm">
                <Checkbox name="isActive" defaultChecked={training.isActive} /> Active
              </label>
            </div>
            <FormActions>
              <SubmitButton>Save training</SubmitButton>
            </FormActions>
          </form>
        </Card>
      </div>
    </>
  );
}
