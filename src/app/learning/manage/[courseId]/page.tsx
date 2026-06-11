import { notFound } from "next/navigation";
import { requirePermission } from "@/platform/auth/session";
import { prisma } from "@/platform/db";
import { PageHeader } from "@/platform/ui/page-header";
import { getCourseForEdit } from "@/modules/learning/services/courses";
import { updateCourseAction, setAssignmentAction, uploadPackageAction } from "../actions";

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
          <input name="title" defaultValue={course.title} className="w-full rounded border border-slate-300 px-3 py-1.5" />
          <textarea name="description" defaultValue={course.description ?? ""} placeholder="Description" className="w-full rounded border border-slate-300 px-3 py-1.5" />
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="isActive" defaultChecked={course.isActive} /> Active</label>
          <button className="rounded bg-slate-800 px-3 py-1.5 text-white" type="submit">Save course</button>
        </form>

        <form action={setAssignmentAction} className="space-y-2">
          <input type="hidden" name="courseId" value={course.id} />
          <h2 className="font-medium">Assignment</h2>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="assignToAll" defaultChecked={course.assignToAll} /> Assign to all departments</label>
          <div className="grid grid-cols-2 gap-1 text-sm">
            {departments.map((d) => (
              <label key={d.id} className="flex items-center gap-2">
                <input type="checkbox" name="departmentIds" value={d.id} defaultChecked={assignedDeptIds.has(d.id)} /> {d.name}
              </label>
            ))}
          </div>
          <button className="rounded bg-slate-800 px-3 py-1.5 text-white" type="submit">Save assignment</button>
        </form>

        <div className="space-y-2">
          <h2 className="font-medium">SCORM package</h2>
          <p className="text-sm text-slate-500">
            {course.scormEntryHref
              ? `Uploaded${course.scormUploadedAt ? ` ${course.scormUploadedAt.toLocaleDateString()}` : ""} · launch: ${course.scormEntryHref} · SCORM ${course.scormVersion ?? "1.2"}`
              : "No package uploaded yet."}
          </p>
          <form action={uploadPackageAction} encType="multipart/form-data" className="space-y-2 rounded border border-slate-200 p-3">
            <input type="hidden" name="courseId" value={course.id} />
            <input type="file" name="package" accept=".zip,application/zip" required className="block text-sm" />
            <p className="text-xs text-slate-400">Export from eXeLearning as SCORM 1.2, then upload the .zip. Uploading replaces any existing package.</p>
            <button className="rounded bg-slate-800 px-3 py-1.5 text-white" type="submit">{course.scormEntryHref ? "Replace package" : "Upload package"}</button>
          </form>
        </div>
      </div>
    </>
  );
}
