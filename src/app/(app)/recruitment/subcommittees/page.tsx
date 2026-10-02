import Link from "next/link";
import { requirePermission } from "@/platform/auth/session";
import { listSubcommittees } from "@/modules/admin/services/subcommittees";
import { PageHeader } from "@/platform/ui/page-header";
import { Badge } from "@/platform/ui/badge";
import { Table, THead, TR, TH, TD } from "@/platform/ui/table";
import { buttonClasses } from "@/platform/ui/button";
import { TextLink } from "@/platform/ui/text-link";

export default async function SubcommitteesListPage() {
  await requirePermission("recruitment.manage_cycles");
  const subcommittees = await listSubcommittees();

  return (
    <div className="space-y-6">
      <PageHeader
        title="Subcommittees"
        description="Manage subcommittees, their leads and members, and whether volunteers can sign up."
        action={
          <Link href="/recruitment/subcommittees/new" className={buttonClasses("primary", "sm")}>
            Create subcommittee
          </Link>
        }
      />
      <Table>
        <THead>
          <TR>
            <TH>Name</TH>
            <TH>Status</TH>
            <TH>Sign-up</TH>
            <TH>Members</TH>
            <TH>Assigned (applications)</TH>
          </TR>
        </THead>
        <tbody>
          {subcommittees.map((s) => (
            <TR key={s.id} className={s.isActive ? "" : "opacity-60"}>
              <TD>
                <TextLink href={`/recruitment/subcommittees/${s.id}`} className="font-medium">
                  {s.name}
                </TextLink>
              </TD>
              <TD>
                {s.isActive ? <Badge tone="success">Active</Badge> : <Badge tone="default">Inactive</Badge>}
              </TD>
              <TD>
                {s.signupOpen ? <Badge tone="brand">Open</Badge> : <span className="text-subtle-foreground">Closed</span>}
              </TD>
              <TD>
                {s._count.memberships}
                {s.capacity !== null && <span className="text-subtle-foreground"> (cap {s.capacity})</span>}
              </TD>
              <TD>{s._count.assignedApplications}</TD>
            </TR>
          ))}
          {subcommittees.length === 0 && (
            <TR>
              <TD colSpan={5} className="py-10 text-center text-sm text-subtle-foreground">
                No subcommittees yet.
              </TD>
            </TR>
          )}
        </tbody>
      </Table>
    </div>
  );
}
