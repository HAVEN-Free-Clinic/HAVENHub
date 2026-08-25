import { requirePermission } from "@/platform/auth/session";
import { scopeEditorDepartments } from "@/platform/departments";
import { PageHeader } from "@/platform/ui/page-header";
import { SectionHeader } from "@/platform/ui/section-header";
import { Card } from "@/platform/ui/card";
import { Input, Textarea, Field } from "@/platform/ui/input";
import { Checkbox } from "@/platform/ui/checkbox";
import { FormActions } from "@/platform/ui/form";
import { SubmitButton } from "@/platform/ui/submit-button";
import { notFound } from "next/navigation";
import { getTrainingForEdit } from "@/platform/ehs/services/trainings";
import { updateTrainingAction, setTrainingDepartmentsAction } from "../actions";

export default async function EditEhsTrainingPage({
  params,
}: {
  params: Promise<{ trainingId: string }>;
}) {
  await requirePermission("volunteers.manage_compliance");
  const { trainingId } = await params;
  const training = await getTrainingForEdit(trainingId);
  if (!training) notFound();
  const assigned = new Set(training.departments.map((d: { departmentId: string }) => d.departmentId));
  // Include already-assigned departments even if now inactive, so a deactivated
  // assignment isn't dropped by this replace-set form's next save (#29).
  const departments = await scopeEditorDepartments([...assigned]);

  return (
    <>
      <PageHeader title={`Edit: ${training.name}`} description="Edit this EHS training requirement." />
      <div className="mt-6 grid max-w-3xl gap-8">
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
              <Field
                label="Completion link"
                hint="Where members go to complete this. Workday Learning for courses, HealthOnTrack for health requirements (TB baseline, HepB immunity). Leave blank when there is nothing for them to do and you record it for them."
              >
                <Input
                  name="completionUrl"
                  type="url"
                  defaultValue={training.completionUrl ?? ""}
                  placeholder="https://www.myworkday.com/yale/learning"
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
          <SectionHeader level="title">Department scope</SectionHeader>
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
                    {!d.isActive && <span className="text-muted-foreground"> (inactive)</span>}
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
