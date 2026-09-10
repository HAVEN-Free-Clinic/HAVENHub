import { notFound } from "next/navigation";
import { PageBody } from "@/platform/ui/page-body";
import { requirePermission, requirePersonSession } from "@/platform/auth/session";
import { getCycle } from "@/modules/recruitment/services/cycles";
import { listAcceptedForAssignment, listAssignableSubcommittees } from "@/modules/recruitment/services/subcommittees";
import { RecruitmentAuthError } from "@/modules/recruitment/services/review";
import { assignSubcommitteesAction } from "./actions";
import { SetBreadcrumb } from "@/platform/ui/breadcrumb-context";
import { cycleTrail } from "@/modules/recruitment/breadcrumbs";
import { PageHeader } from "@/platform/ui/page-header";
import { TD, TH, THead, TR, Table, TableEmpty } from "@/platform/ui/table";
import { Select } from "@/platform/ui/select";
import { Badge } from "@/platform/ui/badge";
import { SubmitButton } from "@/platform/ui/submit-button";
import { ListEmpty } from "@/platform/ui/list-empty";

type PageProps = {
  params: Promise<{ id: string }>;
};

export default async function AssignSubcommitteesPage({ params }: PageProps) {
  const { id } = await params;
  await requirePermission("recruitment.access");
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
    <PageBody>
      <SetBreadcrumb
        trail={cycleTrail({
          cycleId: id,
          cycleTitle: cycle.title,
          section: { label: "Subcommittees", slug: "subcommittees" },
        })}
      />
      <PageHeader title="Assign subcommittees" description={`${cycle.title}: accepted applicants and their ranked preferences.`} />

      {/* One form for the whole table and one Save: it used to be a Save button,
          and a full reload, per row. Each row posts its choice beside the value
          it rendered with, so only rows that moved are written. */}
      <form action={assignSubcommitteesAction.bind(null, id)} className="space-y-4">
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
            {rows.map((r) => {
              // Kept as an option while it is the current assignment, even once
              // deactivated: otherwise the row shows "Unassigned" and the next
              // Save, made for some other row, would quietly clear this one.
              const inactiveCurrent = r.assignedSubcommittee && !r.assignedSubcommittee.active ? r.assignedSubcommittee : null;
              return (
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
                    <input type="hidden" name={`was:${r.applicationId}`} value={r.assignedSubcommitteeId ?? ""} />
                    <Select name={`sub:${r.applicationId}`} defaultValue={r.assignedSubcommitteeId ?? ""} className="w-44" aria-label={`Subcommittee for ${r.applicant.firstName} ${r.applicant.lastName}`}>
                      <option value="">Unassigned</option>
                      {inactiveCurrent && <option value={inactiveCurrent.id}>{inactiveCurrent.name} (inactive)</option>}
                      {subcommittees.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                    </Select>
                  </TD>
                </TR>
              );
            })}
            {rows.length === 0 && (
              <TableEmpty colSpan={4}>
                <ListEmpty filtered={false} noun="accepted applicants" />
              </TableEmpty>
            )}
          </tbody>
        </Table>
        {rows.length > 0 && (
          // Floats at the bottom of the screen while the table scrolls, so the
          // one Save is in reach from row 1 and row 183 alike.
          <div className="sticky bottom-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-surface px-4 py-3 shadow-sm">
            <p className="text-sm text-muted-foreground">Change as many rows as you need, then save once.</p>
            <SubmitButton size="sm" pendingLabel="Saving…">Save assignments</SubmitButton>
          </div>
        )}
      </form>
    </PageBody>
  );
}
