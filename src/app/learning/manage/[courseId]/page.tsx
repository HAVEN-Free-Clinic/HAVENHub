import { notFound } from "next/navigation";
import { requirePermission } from "@/platform/auth/session";
import { prisma } from "@/platform/db";
import { PageHeader } from "@/platform/ui/page-header";
import { getCourseForEdit } from "@/modules/learning/services/courses";
import { updateCourseAction, setAssignmentAction, addModuleAction } from "../actions";

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
          <h2 className="font-medium">Modules</h2>
          <ol className="list-decimal space-y-1 pl-5 text-sm">
            {course.modules.map((m) => (
              <li key={m.id}>{m.title} <span className="text-slate-400">({m.kind})</span></li>
            ))}
          </ol>
          <form action={addModuleAction} className="space-y-2 rounded border border-slate-200 p-3">
            <input type="hidden" name="courseId" value={course.id} />
            <input name="title" placeholder="Module title" required className="w-full rounded border border-slate-300 px-3 py-1.5" />
            <select name="kind" className="w-full rounded border border-slate-300 px-3 py-1.5">
              <option value="VIDEO">Video</option>
              <option value="DOCUMENT">Document</option>
              <option value="QUIZ">Quiz</option>
            </select>
            <input name="url" placeholder="Link (video/document)" className="w-full rounded border border-slate-300 px-3 py-1.5" />
            <textarea name="questions" placeholder='Quiz questions JSON: [{"key":"q1","label":"...","options":[{"value":"a","label":"A"}],"correctValue":"a"}]' className="w-full rounded border border-slate-300 px-3 py-1.5 font-mono text-xs" />
            <div className="flex gap-2">
              <input name="passPercent" type="number" placeholder="Pass %" className="w-24 rounded border border-slate-300 px-3 py-1.5" />
              <input name="maxAttempts" type="number" placeholder="Attempts" className="w-24 rounded border border-slate-300 px-3 py-1.5" />
            </div>
            <button className="rounded bg-slate-800 px-3 py-1.5 text-white" type="submit">Add module</button>
          </form>
        </div>
      </div>
    </>
  );
}
