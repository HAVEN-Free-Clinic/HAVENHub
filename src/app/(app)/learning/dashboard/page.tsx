import { requirePermission } from "@/platform/auth/session";
import { PageHeader } from "@/platform/ui/page-header";
import { Button } from "@/platform/ui/button";
import { Select } from "@/platform/ui/select";
import { Table, THead, TR, TH, TD } from "@/platform/ui/table";
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
          <Select id="course" name="course" defaultValue={selected} className="w-auto">
            {courses.map((c) => (
              <option key={c.id} value={c.id}>{c.title}</option>
            ))}
          </Select>
          <Button type="submit" size="sm">View</Button>
        </form>

        <Table>
          <THead>
            <TR className="border-t-0">
              <TH>Name</TH>
              <TH>Dept</TH>
              <TH>Status</TH>
              <TH>Score</TH>
              <TH />
            </TR>
          </THead>
          <tbody>
            {rows.map((r) => (
              <TR key={r.personId}>
                <TD>{r.name}</TD>
                <TD>{r.departmentCode}</TD>
                <TD>{r.status === "COMPLETE" ? "Complete" : r.status === "IN_PROGRESS" ? "In progress" : "Not started"}</TD>
                <TD>{r.scoreRaw != null ? `${r.scoreRaw}%` : ""}</TD>
                <TD className="text-right text-xs text-subtle-foreground">
                  {r.completedAt ? r.completedAt.toLocaleDateString() : ""}
                  {r.status !== "NOT_STARTED" && selected && (
                    <form action={resetCourseProgressAction} className="inline ml-2">
                      <input type="hidden" name="personId" value={r.personId} />
                      <input type="hidden" name="courseId" value={selected} />
                      <Button type="submit" variant="outline" size="sm">Reset</Button>
                    </form>
                  )}
                </TD>
              </TR>
            ))}
            {rows.length === 0 && (
              <TR>
                <TD colSpan={5} className="text-muted-foreground">No learners for this course.</TD>
              </TR>
            )}
          </tbody>
        </Table>
      </div>
    </>
  );
}
