import Link from "next/link";
import { requirePermission } from "@/platform/auth/session";
import { listTerms } from "@/modules/admin/services/terms";
import { PageHeader } from "@/platform/ui/page-header";
import { Badge } from "@/platform/ui/badge";
import { Table, THead, TR, TH, TD } from "@/platform/ui/table";
import { buttonClasses } from "@/platform/ui/button";

function formatUtcDate(d: Date): string {
  return d.toLocaleDateString("en-US", {
    timeZone: "UTC",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export default async function TermsListPage() {
  await requirePermission("admin.manage_terms");

  const terms = await listTerms();

  return (
    <div className="space-y-6">
      <PageHeader
        title="Terms"
        description="Manage clinic terms, their dates, lifecycle, and rosters."
        action={
          <Link href="/admin/terms/new" className={buttonClasses("primary", "sm")}>
            Create term
          </Link>
        }
      />

      <Table>
        <THead>
          <TR>
            <TH>Code</TH>
            <TH>Name</TH>
            <TH>Start</TH>
            <TH>End</TH>
            <TH>Clinic dates</TH>
            <TH>Status</TH>
            <TH>Members</TH>
          </TR>
        </THead>
        <tbody>
          {terms.map((term) => (
            <TR key={term.id}>
              <TD>
                <Link
                  href={`/admin/terms/${term.id}`}
                  className="font-medium text-brand hover:underline"
                >
                  {term.code}
                </Link>
              </TD>
              <TD>{term.name}</TD>
              <TD>{formatUtcDate(term.startDate)}</TD>
              <TD>{formatUtcDate(term.endDate)}</TD>
              <TD>{term.clinicDates.length}</TD>
              <TD>
                {term.status === "ACTIVE" ? (
                  <Badge tone="brand">Active</Badge>
                ) : term.status === "PLANNING" ? (
                  <Badge tone="default">Planning</Badge>
                ) : (
                  <Badge tone="warning">Archived</Badge>
                )}
              </TD>
              <TD>{term._count.memberships}</TD>
            </TR>
          ))}
          {terms.length === 0 && (
            <TR>
              <TD colSpan={7} className="py-10 text-center text-sm text-slate-400">
                No terms yet.
              </TD>
            </TR>
          )}
        </tbody>
      </Table>
    </div>
  );
}
