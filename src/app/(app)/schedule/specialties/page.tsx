import Link from "next/link";
import { requirePermission } from "@/platform/auth/session";
import { listAttendingSpecialties } from "@/modules/admin/services/attending-specialties";
import { PageHeader } from "@/platform/ui/page-header";
import { Badge } from "@/platform/ui/badge";
import { Table, THead, TR, TH, TD } from "@/platform/ui/table";
import { buttonClasses } from "@/platform/ui/button";

export default async function AttendingSpecialtiesListPage() {
  await requirePermission("schedule.manage_attendings");
  const specialties = await listAttendingSpecialties();

  return (
    <div className="space-y-6">
      <PageHeader
        title="Attending specialties"
        description="The clinical specialties attendings work in, and which of them can run a date's rotating Specialty Clinic."
        action={
          <Link href="/schedule/specialties/new" className={buttonClasses("primary", "sm")}>
            Create specialty
          </Link>
        }
      />
      <Table>
        <THead>
          <TR>
            <TH>Code</TH>
            <TH>Name</TH>
            <TH>Specialty clinic</TH>
            <TH>Attendings</TH>
            <TH>Clinic days</TH>
            <TH></TH>
          </TR>
        </THead>
        <tbody>
          {specialties.map((s) => (
            <TR key={s.id}>
              <TD className="font-medium">{s.code}</TD>
              <TD>{s.name}</TD>
              <TD>
                {s.runsSpecialtyClinic ? (
                  <Badge tone="brand">Rotates</Badge>
                ) : (
                  <Badge tone="default">No</Badge>
                )}
              </TD>
              <TD>{s._count.attendings}</TD>
              <TD>{s._count.clinicDays}</TD>
              <TD>
                <Link
                  href={`/schedule/specialties/${s.id}`}
                  className={buttonClasses("outline", "sm")}
                >
                  Edit
                </Link>
              </TD>
            </TR>
          ))}
          {specialties.length === 0 && (
            <TR>
              <TD colSpan={6} className="py-10 text-center text-sm text-subtle-foreground">
                No specialties yet.
              </TD>
            </TR>
          )}
        </tbody>
      </Table>
    </div>
  );
}
