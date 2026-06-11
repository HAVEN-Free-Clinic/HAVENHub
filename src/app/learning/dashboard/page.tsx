import { requirePermission } from "@/platform/auth/session";
import { PageHeader } from "@/platform/ui/page-header";
import { listCoursesForDashboard, getCourseCompletion } from "@/modules/learning/services/dashboard";
import { resetCourseProgressAction } from "./actions";

export default async function LearningDashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ course?: string }>;
}) {
  const person = await requirePermission("learning.view_progress");
  const courses = await listCoursesForDashboard(person.personId);
  const sp = await searchParams;
  const selected = sp.course ?? courses[0]?.id;
  const rows = selected ? await getCourseCompletion(selected, person.personId) : [];

  return (
    <>
      <PageHeader title="Course completion" description="Who has completed each course, by department." />
      <div className="mt-6 max-w-3xl space-y-4">
        <form method="get" className="flex items-center gap-2 text-sm">
          <label htmlFor="course">Course</label>
          <select id="course" name="course" defaultValue={selected} className="rounded border border-slate-300 px-3 py-1.5">
            {courses.map((c) => (
              <option key={c.id} value={c.id}>{c.title}</option>
            ))}
          </select>
          <button className="rounded bg-slate-800 px-3 py-1 text-white" type="submit">View</button>
        </form>

        <table className="w-full text-left text-sm">
          <thead className="border-b border-slate-200 text-slate-500">
            <tr><th className="py-2">Name</th><th>Dept</th><th>Status</th><th>Score</th><th></th></tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.personId} className="border-b border-slate-100">
                <td className="py-2">{r.name}</td>
                <td>{r.departmentCode}</td>
                <td>{r.status === "COMPLETE" ? "Complete" : r.status === "IN_PROGRESS" ? "In progress" : "Not started"}</td>
                <td>{r.scoreRaw != null ? `${r.scoreRaw}%` : ""}</td>
                <td className="text-right text-xs text-slate-400">
                  {r.completedAt ? r.completedAt.toLocaleDateString() : ""}
                  {r.status !== "NOT_STARTED" && selected && (
                    <form action={resetCourseProgressAction} className="inline ml-2">
                      <input type="hidden" name="personId" value={r.personId} />
                      <input type="hidden" name="courseId" value={selected} />
                      <button type="submit" className="rounded bg-slate-200 px-2 py-0.5 text-slate-700 text-xs hover:bg-slate-300">
                        Reset
                      </button>
                    </form>
                  )}
                </td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={5} className="py-3 text-slate-500">No learners for this course.</td></tr>}
          </tbody>
        </table>
      </div>
    </>
  );
}
