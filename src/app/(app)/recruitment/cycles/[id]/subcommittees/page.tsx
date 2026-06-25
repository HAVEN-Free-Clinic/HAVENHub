import { notFound } from "next/navigation";
import { requirePersonSession } from "@/platform/auth/session";
import { getCycle } from "@/modules/recruitment/services/cycles";
import { listAcceptedForAssignment, listAssignableSubcommittees } from "@/modules/recruitment/services/subcommittees";
import { RecruitmentAuthError } from "@/modules/recruitment/services/review";
import { assignSubcommitteeAction } from "./actions";
import { SetBreadcrumb } from "@/platform/ui/breadcrumb-context";
import { cycleTrail } from "@/modules/recruitment/breadcrumbs";
import { PageHeader } from "@/platform/ui/page-header";
import { Table, THead, TR, TH, TD } from "@/platform/ui/table";
import { Select } from "@/platform/ui/select";
import { Alert } from "@/platform/ui/alert";
import { Badge } from "@/platform/ui/badge";
import { SubmitButton } from "@/platform/ui/submit-button";

type PageProps = {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string; saved?: string }>;
};

export default async function AssignSubcommitteesPage({ params, searchParams }: PageProps) {
  const { id } = await params;
  const { error, saved } = await searchParams;
  const [person, cycle] = await Promise.all([requirePersonSession(), getCycle(id)]);
  if (!cycle) notFound();

  let rows;
  try {
    rows = await listAcceptedForAssignment(id, person.personId);
  } catch (err) {
    if (err instanceof RecruitmentAuthError) notFound();
    throw err;
  }
  const subcommittees = await listAssignableSubcommittees();

  return (
    <div className="space-y-6">
      <SetBreadcrumb
        trail={cycleTrail({
          cycleId: id,
          cycleTitle: cycle.title,
          section: { label: "Subcommittees", slug: "subcommittees" },
        })}
      />
      <PageHeader title="Assign subcommittees" description={`${cycle.title}: accepted applicants and their ranked preferences.`} />
      {error && <Alert tone="error">{error}</Alert>}
      {saved && <Alert tone="success">Assignment saved.</Alert>}

      <Table>
        <THead>
          <TR>
            <TH>Name</TH>
            <TH>Accepted</TH>
            <TH>Ranked preferences</TH>
            <TH>Assignment</TH>
          </TR>
        </THead>
        <tbody>
          {rows.map((r) => (
            <TR key={r.applicationId}>
              <TD className="font-medium">{r.applicant.firstName} {r.applicant.lastName}</TD>
              <TD className="text-foreground-soft">{r.acceptedDepartments.join(", ")}</TD>
              <TD className="text-foreground-soft">
                {r.ranking.length === 0
                  ? <span className="text-subtle-foreground">None ranked</span>
                  : (
                    <ol className="list-decimal pl-4">
                      {r.ranking.map((s) => (
                        <li key={s.id}>
                          {s.name}
                          {!s.active && <Badge tone="default" className="ml-1">inactive</Badge>}
                        </li>
                      ))}
                    </ol>
                  )}
              </TD>
              <TD>
                <form action={assignSubcommitteeAction.bind(null, id, r.applicationId)} className="flex items-center gap-2">
                  <Select name="subcommitteeId" defaultValue={r.assignedSubcommitteeId ?? ""} className="w-44">
                    <option value="">Unassigned</option>
                    {subcommittees.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </Select>
                  <SubmitButton size="sm" pendingLabel="Saving...">Save</SubmitButton>
                </form>
              </TD>
            </TR>
          ))}
          {rows.length === 0 && (
            <TR>
              <TD colSpan={4} className="py-10 text-center text-subtle-foreground">
                No accepted applicants yet.
              </TD>
            </TR>
          )}
        </tbody>
      </Table>
    </div>
  );
}
