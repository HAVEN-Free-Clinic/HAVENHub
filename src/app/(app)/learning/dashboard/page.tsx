import Link from "next/link";
import { requirePermission } from "@/platform/auth/session";
import { can } from "@/platform/rbac/engine";
import { PageHeader } from "@/platform/ui/page-header";
import { Button } from "@/platform/ui/button";
import { ConfirmButton } from "@/platform/ui/confirm-button";
import { Card } from "@/platform/ui/card";
import { Select } from "@/platform/ui/select";
import { Table, THead, TR, TH, TD } from "@/platform/ui/table";
import { Pagination } from "@/platform/ui/pagination";
import { listCoursesForDashboard, getCourseCompletion } from "@/modules/learning/services/dashboard";
import { resetCourseProgressAction } from "./actions";

export default async function LearningDashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ course?: string; page?: string }>;
}) {
  const person = await requirePermission("learning.view_progress");
  const canManage = await can(person.personId, "learning.manage_courses");
  const courses = await listCoursesForDashboard(person.personId);

  if (courses.length === 0) {
    return (
      <>
        <PageHeader title="Course completion" description="Who has completed each course, by department." />
        <Card className="mt-6 max-w-3xl text-sm text-muted-foreground">
          No courses exist yet.{" "}
          {canManage ? (
            <>
              <Link href="/learning/manage" className="font-medium text-brand-fg hover:underline">
                Create a course
              </Link>{" "}
              to start tracking completion.
            </>
          ) : (
            "Completion will appear here once courses have been created."
          )}
        </Card>
      </>
    );
  }

  const sp = await searchParams;
  const selected = sp.course ?? courses[0]?.id;
  const rows = selected ? await getCourseCompletion(selected, person.personId) : [];
  // Bound the rendered table: a full clinic roster can be hundreds of learners,
  // each emitting a Reset form. Page in-memory (the sorted roster is one bounded
  // query) so the DOM stays small, mirroring the master-compliance view.
  const PAGE_SIZE = 25;
  const pageCount = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const page = Math.min(Math.max(1, parseInt(sp.page ?? "1", 10) || 1), pageCount);
  const pageRows = rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

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
            {pageRows.map((r) => (
              <TR key={r.personId}>
                <TD>{r.name}</TD>
                <TD>{r.departmentCode}</TD>
                <TD>{r.status === "COMPLETE" ? "Complete" : r.status === "IN_PROGRESS" ? "In progress" : "Not started"}</TD>
                <TD>{r.scoreRaw != null ? `${r.scoreRaw}%` : ""}</TD>
                <TD className="text-right text-xs text-subtle-foreground">
                  {r.completedAt ? r.completedAt.toLocaleDateString() : ""}
                  {canManage && r.status !== "NOT_STARTED" && selected && (
                    <form action={resetCourseProgressAction} className="inline ml-2">
                      <input type="hidden" name="personId" value={r.personId} />
                      <input type="hidden" name="courseId" value={selected} />
                      <ConfirmButton label="Reset" size="sm" />
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
        {selected && (
          <Pagination
            page={page}
            pageCount={pageCount}
            hrefFor={(p) => `/learning/dashboard?course=${encodeURIComponent(selected)}&page=${p}`}
          />
        )}
      </div>
    </>
  );
}
