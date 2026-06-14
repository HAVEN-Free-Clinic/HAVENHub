import Link from "next/link";
import { requirePermission } from "@/platform/auth/session";
import { listDepartments } from "@/modules/admin/services/departments";
import { PageHeader } from "@/platform/ui/page-header";
import { Badge } from "@/platform/ui/badge";
import { Table, THead, TR, TH, TD } from "@/platform/ui/table";
import { buttonClasses } from "@/platform/ui/button";

export default async function DepartmentsListPage() {
  await requirePermission("admin.manage_departments");
  const departments = await listDepartments();

  return (
    <div className="space-y-6">
      <PageHeader
        title="Departments"
        description="Manage departments, their capacity, and delegation (who oversees whom)."
        action={
          <Link href="/admin/departments/new" className={buttonClasses("primary", "sm")}>
            Create department
          </Link>
        }
      />
      <Table>
        <THead>
          <TR>
            <TH>Code</TH>
            <TH>Name</TH>
            <TH>Status</TH>
            <TH>Manages</TH>
            <TH>Members</TH>
            <TH></TH>
          </TR>
        </THead>
        <tbody>
          {departments.map((d) => (
            <TR key={d.id} className={d.isActive ? "" : "opacity-60"}>
              <TD className="font-medium">{d.code}</TD>
              <TD>{d.name}</TD>
              <TD>
                {d.isActive ? (
                  <Badge tone="success">Active</Badge>
                ) : (
                  <Badge tone="default">Inactive</Badge>
                )}
              </TD>
              <TD>{d.managesDelegations.length}</TD>
              <TD>{d._count.memberships}</TD>
              <TD>
                <Link href={`/admin/departments/${d.id}`} className={buttonClasses("outline", "sm")}>
                  Edit
                </Link>
              </TD>
            </TR>
          ))}
          {departments.length === 0 && (
            <TR>
              <TD colSpan={6} className="py-10 text-center text-sm text-subtle-foreground">
                No departments yet.
              </TD>
            </TR>
          )}
        </tbody>
      </Table>
    </div>
  );
}
