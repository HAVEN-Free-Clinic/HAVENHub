import { notFound } from "next/navigation";
import { requirePermission } from "@/platform/auth/session";
import { scopeEditorDepartments } from "@/platform/departments";
import { PageHeader } from "@/platform/ui/page-header";
import { SectionHeader } from "@/platform/ui/section-header";
import { Card } from "@/platform/ui/card";
import { Input, Textarea, Field } from "@/platform/ui/input";
import { Checkbox } from "@/platform/ui/checkbox";
import { Select } from "@/platform/ui/select";
import { Alert } from "@/platform/ui/alert";
import { FormActions } from "@/platform/ui/form";
import { SubmitButton } from "@/platform/ui/submit-button";
import { getCourseForEdit } from "@/modules/learning/services/courses";
import { formatDateOnly } from "@/platform/dates";
import { getDisplayTimeZone } from "@/platform/dates/resolve";
import { usingBlobStorage } from "@/platform/storage";
import { updateCourseAction, setAssignmentAction } from "../actions";
import { UploadPackageForm } from "./UploadPackageForm";

export default async function EditCoursePage({
  params,
}: {
  params: Promise<{ courseId: string }>;
}) {
  await requirePermission("learning.manage_courses");
  const { courseId } = await params;
  const course = await getCourseForEdit(courseId);
  if (!course) notFound();
  const zone = await getDisplayTimeZone();
  const assignedDeptIds = new Set(course.departments.map((d) => d.departmentId));
  // Include already-assigned departments even if now inactive, so a deactivated
  // assignment isn't dropped by this replace-set form's next save (#21).
  const departments = await scopeEditorDepartments([...assignedDeptIds]);
  const isAssigned = course.assignToAll || course.departments.length > 0;
  const hasPackage = course.scormEntryHref != null;

  return (
    <>
      <PageHeader title={`Edit: ${course.title}`} />
      <div className="mt-6 grid max-w-3xl gap-8">
        {course.isActive && isAssigned && !hasPackage && (
          <Alert tone="warning">
            This course is assigned but has no SCORM package yet, so it is hidden from members and does
            not count toward onboarding. Upload a package below to make it visible and required.
          </Alert>
        )}
        <Card>
          <form action={updateCourseAction}>
            <input type="hidden" name="courseId" value={course.id} />
            <div className="space-y-4">
              <Field label="Title">
                <Input name="title" defaultValue={course.title} required />
              </Field>
              <Field label="Description">
                <Textarea name="description" defaultValue={course.description ?? ""} placeholder="Description" />
              </Field>
              <Field
                label="Recurrence"
                hint="Takes effect next term, not immediately. Volunteers already complete this term keep their status; the retake starts next term."
              >
                <Select name="recurrence" defaultValue={course.recurrence} className="max-w-xs">
                  <option value="ONCE">Complete once, cleared forever</option>
                  <option value="PER_TERM">Retake each term</option>
                </Select>
              </Field>
              <label className="flex items-center gap-2 text-sm">
                <Checkbox name="isActive" defaultChecked={course.isActive} /> Active
              </label>
            </div>
            <FormActions>
              <SubmitButton>Save course</SubmitButton>
            </FormActions>
          </form>
        </Card>

        <Card className="space-y-4">
          <SectionHeader level="title">Assignment</SectionHeader>
          <form action={setAssignmentAction}>
            <input type="hidden" name="courseId" value={course.id} />
            <div className="space-y-4">
              <label className="flex items-center gap-2 text-sm">
                <Checkbox name="assignToAll" defaultChecked={course.assignToAll} /> Assign to all departments
              </label>
              <Field label="Audience">
                <Select name="audience" defaultValue={course.audience} className="max-w-xs">
                  <option value="EVERYONE">Everyone</option>
                  <option value="DIRECTORS">Directors only</option>
                  <option value="VOLUNTEERS">Volunteers only</option>
                </Select>
              </Field>
              <div className="grid grid-cols-1 gap-1 text-sm sm:grid-cols-2">
                {departments.map((d) => (
                  <label key={d.id} className="flex items-center gap-2">
                    <Checkbox name="departmentIds" value={d.id} defaultChecked={assignedDeptIds.has(d.id)} /> {d.name}
                    {!d.isActive && <span className="text-muted-foreground"> (inactive)</span>}
                  </label>
                ))}
              </div>
            </div>
            <FormActions>
              <SubmitButton>Save assignment</SubmitButton>
            </FormActions>
          </form>
        </Card>

        <div className="space-y-2">
          <SectionHeader level="title">SCORM package</SectionHeader>
          <p className="text-sm text-muted-foreground">
            {course.scormEntryHref
              ? `Uploaded${course.scormUploadedAt ? ` ${formatDateOnly(course.scormUploadedAt, zone)}` : ""} · launch: ${course.scormEntryHref} · SCORM ${course.scormVersion ?? "1.2"}`
              : "No package uploaded yet."}
          </p>
          <UploadPackageForm courseId={course.id} hasPackage={course.scormEntryHref != null} usingBlob={usingBlobStorage} />
        </div>
      </div>
    </>
  );
}
