import Link from "next/link";
import { requirePermission } from "@/platform/auth/session";
import { listSubcommittees } from "@/modules/admin/services/subcommittees";
import { PageHeader } from "@/platform/ui/page-header";
import { Badge } from "@/platform/ui/badge";
import { Table, THead, TR, TH, TD } from "@/platform/ui/table";
import { buttonClasses } from "@/platform/ui/button";

export default async function SubcommitteesListPage() {
  await requirePermission("admin.manage_subcommittees");
  const subcommittees = await listSubcommittees();

  return (
    <div className="space-y-6">
      <PageHeader
        title="Subcommittees"
        description="Manage the subcommittees applicants rank and the recruitment team assigns."
        action={
          <Link href="/admin/subcommittees/new" className={buttonClasses("primary", "sm")}>
            Create subcommittee
          </Link>
        }
      />
      <Table>
        <THead>
          <TR>
            <TH>Name</TH>
            <TH>Status</TH>
            <TH>Assigned</TH>
            <TH></TH>
          </TR>
        </THead>
        <tbody>
          {subcommittees.map((s) => (
            <TR key={s.id} className={s.isActive ? "" : "opacity-60"}>
              <TD className="font-medium">{s.name}</TD>
              <TD>
                {s.isActive ? <Badge tone="success">Active</Badge> : <Badge tone="default">Inactive</Badge>}
              </TD>
              <TD>{s._count.assignedApplications}</TD>
              <TD>
                <Link href={`/admin/subcommittees/${s.id}`} className={buttonClasses("outline", "sm")}>
                  Edit
                </Link>
              </TD>
            </TR>
          ))}
          {subcommittees.length === 0 && (
            <TR>
              <TD colSpan={4} className="py-10 text-center text-sm text-subtle-foreground">
                No subcommittees yet.
              </TD>
            </TR>
          )}
        </tbody>
      </Table>
    </div>
  );
}
