import { notFound } from "next/navigation";
import { requirePermission } from "@/platform/auth/session";
import { prisma } from "@/platform/db";
import { PageHeader } from "@/platform/ui/page-header";
import { Card } from "@/platform/ui/card";
import { Input, Textarea, Field } from "@/platform/ui/input";
import { Checkbox } from "@/platform/ui/checkbox";
import { Select } from "@/platform/ui/select";
import { Alert } from "@/platform/ui/alert";
import { FormActions } from "@/platform/ui/form";
import { SubmitButton } from "@/platform/ui/submit-button";
import { getCourseForEdit } from "@/modules/learning/services/courses";
import { usingBlobStorage } from "@/platform/storage";
import { updateCourseAction, setAssignmentAction } from "../actions";
import { UploadPackageForm } from "./UploadPackageForm";

export default async function EditCoursePage({ params }: { params: Promise<{ courseId: string }> }) {
  await requirePermission("learning.manage_courses");
  const { courseId } = await params;
  const course = await getCourseForEdit(courseId);
  if (!course) notFound();
  const departments = await prisma.department.findMany({ where: { isActive: true }, orderBy: { name: "asc" } });
  const assignedDeptIds = new Set(course.departments.map((d) => d.departmentId));
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
                <Input name="title" defaultValue={course.title} />
              </Field>
              <Field label="Description">
                <Textarea name="description" defaultValue={course.description ?? ""} placeholder="Description" />
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
          <h2 className="font-medium">Assignment</h2>
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
              <div className="grid grid-cols-2 gap-1 text-sm">
                {departments.map((d) => (
                  <label key={d.id} className="flex items-center gap-2">
                    <Checkbox name="departmentIds" value={d.id} defaultChecked={assignedDeptIds.has(d.id)} /> {d.name}
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
          <h2 className="font-medium">SCORM package</h2>
          <p className="text-sm text-muted-foreground">
            {course.scormEntryHref
              ? `Uploaded${course.scormUploadedAt ? ` ${course.scormUploadedAt.toLocaleDateString()}` : ""} · launch: ${course.scormEntryHref} · SCORM ${course.scormVersion ?? "1.2"}`
              : "No package uploaded yet."}
          </p>
          <UploadPackageForm courseId={course.id} hasPackage={course.scormEntryHref != null} usingBlob={usingBlobStorage} />
        </div>
      </div>
    </>
  );
}
