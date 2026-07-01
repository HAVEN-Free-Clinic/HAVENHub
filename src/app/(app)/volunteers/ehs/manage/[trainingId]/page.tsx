import { requirePermission } from "@/platform/auth/session";
import { prisma } from "@/platform/db";
import { PageHeader } from "@/platform/ui/page-header";
import { Card } from "@/platform/ui/card";
import { Input, Textarea, Field } from "@/platform/ui/input";
import { Checkbox } from "@/platform/ui/checkbox";
import { Alert } from "@/platform/ui/alert";
import { FormActions } from "@/platform/ui/form";
import { SubmitButton } from "@/platform/ui/submit-button";
import { getTrainingForEdit } from "@/modules/ehs/services/trainings";
import { updateTrainingAction, setTrainingDepartmentsAction } from "../actions";

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
  const departments = await prisma.department.findMany({
    where: { isActive: true },
    orderBy: { name: "asc" },
  });
  const assigned = new Set(training.departments.map((d: { departmentId: string }) => d.departmentId));

  return (
    <>
      <PageHeader title={`Edit: ${training.name}`} description="Edit this EHS training requirement." />
      <div className="mt-6 grid max-w-3xl gap-8">
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
              <label className="flex items-center gap-2 text-sm">
                <Checkbox name="requiredForAll" defaultChecked={training.requiredForAll} /> Required for all departments
              </label>
            </div>
            <FormActions>
              <SubmitButton>Save training</SubmitButton>
            </FormActions>
          </form>
        </Card>

        <Card className="space-y-4">
          <h2 className="font-medium">Department scope</h2>
          <form action={setTrainingDepartmentsAction}>
            <input type="hidden" name="trainingId" value={training.id} />
            <div className="space-y-4">
              <p className="text-sm text-muted-foreground">
                When not required for all, choose the departments this training applies to.
              </p>
              <div className="grid grid-cols-2 gap-1 text-sm">
                {departments.map((d) => (
                  <label key={d.id} className="flex items-center gap-2">
                    <Checkbox name="departmentIds" value={d.id} defaultChecked={assigned.has(d.id)} /> {d.name}
                  </label>
                ))}
              </div>
            </div>
            <FormActions>
              <SubmitButton>Save departments</SubmitButton>
            </FormActions>
          </form>
        </Card>
      </div>
    </>
  );
}
