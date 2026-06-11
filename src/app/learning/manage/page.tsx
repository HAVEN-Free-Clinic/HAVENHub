import Link from "next/link";
import { requirePermission } from "@/platform/auth/session";
import { PageHeader } from "@/platform/ui/page-header";
import { listCourses } from "@/modules/learning/services/courses";
import { createCourseAction } from "./actions";

export default async function ManageCoursesPage() {
  await requirePermission("learning.manage_courses");
  const courses = await listCourses();

  return (
    <>
      <PageHeader title="Manage courses" description="Create courses and upload their SCORM packages." />
      <div className="mt-6 max-w-2xl space-y-6">
        <form action={createCourseAction} className="flex gap-2">
          <input name="title" placeholder="New course title" required className="flex-1 rounded border border-slate-300 px-3 py-1.5" />
          <button className="rounded bg-slate-800 px-3 py-1.5 text-white" type="submit">Create</button>
        </form>
        <ul className="space-y-2">
          {courses.map((c) => (
            <li key={c.id}>
              <Link href={`/learning/manage/${c.id}`} className="flex items-center justify-between rounded border border-slate-200 px-4 py-2 hover:border-slate-400">
                <span>{c.title}</span>
                <span className="text-xs text-slate-500">
                  {c.hasPackage ? "package uploaded" : "no package"}{c.isActive ? "" : " · inactive"}{c.assignToAll ? " · all depts" : ""}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </>
  );
}
