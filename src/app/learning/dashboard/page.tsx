import { requirePermission } from "@/platform/auth/session";
import { AppShell } from "@/platform/ui/app-shell";
import { PageHeader } from "@/platform/ui/page-header";
import { listCoursesForDashboard, getCourseCompletion } from "@/modules/learning/services/dashboard";

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
    <AppShell userName={person.name} personId={person.personId}>
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
            <tr><th className="py-2">Name</th><th>Dept</th><th>Status</th><th></th></tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.personId} className="border-b border-slate-100">
                <td className="py-2">{r.name}</td>
                <td>{r.departmentCode}</td>
                <td>
                  {r.status === "COMPLETE" ? "Complete" : r.status === "IN_PROGRESS" ? "In progress" : "Not started"}
                  {r.hasLockedQuiz && <span className="ml-2 text-xs text-red-600">locked</span>}
                </td>
                <td className="text-right text-xs text-slate-400">{r.completedAt ? r.completedAt.toLocaleDateString() : ""}</td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={4} className="py-3 text-slate-500">No learners for this course.</td></tr>}
          </tbody>
        </table>
      </div>
    </AppShell>
  );
}
