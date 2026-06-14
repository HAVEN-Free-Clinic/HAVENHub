import { notFound } from "next/navigation";
import { requirePermission } from "@/platform/auth/session";
import { prisma } from "@/platform/db";
import { PageHeader } from "@/platform/ui/page-header";
import { Button } from "@/platform/ui/button";
import { Input, Textarea } from "@/platform/ui/input";
import { Checkbox } from "@/platform/ui/checkbox";
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

  return (
    <>
      <PageHeader title={`Edit: ${course.title}`} />
      <div className="mt-6 grid max-w-3xl gap-8">
        <form action={updateCourseAction} className="space-y-2">
          <input type="hidden" name="courseId" value={course.id} />
          <Input name="title" defaultValue={course.title} />
          <Textarea name="description" defaultValue={course.description ?? ""} placeholder="Description" />
          <label className="flex items-center gap-2 text-sm"><Checkbox name="isActive" defaultChecked={course.isActive} /> Active</label>
          <Button type="submit">Save course</Button>
        </form>

        <form action={setAssignmentAction} className="space-y-2">
          <input type="hidden" name="courseId" value={course.id} />
          <h2 className="font-medium">Assignment</h2>
          <label className="flex items-center gap-2 text-sm"><Checkbox name="assignToAll" defaultChecked={course.assignToAll} /> Assign to all departments</label>
          <div className="grid grid-cols-2 gap-1 text-sm">
            {departments.map((d) => (
              <label key={d.id} className="flex items-center gap-2">
                <Checkbox name="departmentIds" value={d.id} defaultChecked={assignedDeptIds.has(d.id)} /> {d.name}
              </label>
            ))}
          </div>
          <Button type="submit">Save assignment</Button>
        </form>

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
