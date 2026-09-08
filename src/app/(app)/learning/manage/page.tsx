import { requirePermission } from "@/platform/auth/session";
import { PageHeader } from "@/platform/ui/page-header";
import { SubmitButton } from "@/platform/ui/submit-button";
import { Input } from "@/platform/ui/input";
import { Card } from "@/platform/ui/card";
import { listCourses } from "@/modules/learning/services/courses";
import { createCourseAction } from "./actions";
import { Table, THead, TR, TH, TD } from "@/platform/ui/table";
import { TextLink } from "@/platform/ui/text-link";
import { Badge } from "@/platform/ui/badge";
import { ActiveBadge } from "@/platform/ui/active-badge";
import { ListEmpty } from "@/platform/ui/list-empty";

export default async function ManageCoursesPage() {
  await requirePermission("learning.manage_courses");
  const courses = await listCourses();

  return (
    <>
      <PageHeader title="Manage courses" description="Create courses and upload their SCORM packages." />
      <div className="mt-6 max-w-2xl space-y-6">
        <Card>
          <form action={createCourseAction} className="flex gap-2">
            <Input name="title" placeholder="New course title" required className="flex-1" />
            <SubmitButton pendingLabel="Creating…">Create</SubmitButton>
          </form>
        </Card>
        {courses.length === 0 ? (
          <Card pad={false}>
            <ListEmpty
              filtered={false}
              noun="courses"
              emptyDescription="Create your first using the form above."
            />
          </Card>
        ) : (
          <Table>
            <THead>
              <TR>
                <TH>Course</TH>
                <TH>Package</TH>
                <TH>Assignment</TH>
                <TH>Status</TH>
              </TR>
            </THead>
            <tbody>
              {courses.map((c) => (
                <TR key={c.id}>
                  <TD>
                    <TextLink href={`/learning/manage/${c.id}`} className="font-medium">
                      {c.title}
                    </TextLink>
                  </TD>
                  {/* Four facts that used to run together in one sentence
                      ("package uploaded · inactive · all depts"), which is the
                      one shape a reader cannot scan a column of. Same states,
                      same Badges /learning already gives them. */}
                  <TD>
                    <Badge tone={c.hasPackage ? "success" : "warning"}>
                      {c.hasPackage ? "Uploaded" : "No package"}
                    </Badge>
                  </TD>
                  <TD className="text-muted-foreground">
                    {c.assignToAll ? "All departments" : "By department"}
                  </TD>
                  <TD>
                    <ActiveBadge active={c.isActive} />
                  </TD>
                </TR>
              ))}
            </tbody>
          </Table>
        )}
      </div>
    </>
  );
}
