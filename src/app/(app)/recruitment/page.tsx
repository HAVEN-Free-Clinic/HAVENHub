import Link from "next/link";
import { listCycles } from "@/modules/recruitment/services/cycles";
import { PageHeader } from "@/platform/ui/page-header";
import { Table, THead, TR, TH, TD } from "@/platform/ui/table";
import { Badge } from "@/platform/ui/badge";
import { buttonClasses } from "@/platform/ui/button";

const statusTone = {
  DRAFT: "default",
  OPEN: "success",
  CLOSED: "warning",
} as const;

export default async function RecruitmentPage() {
  const cycles = await listCycles();
  return (
    <div className="space-y-6">
      <PageHeader
        title="Recruitment cycles"
        description="Application cycles for volunteers and directors."
        action={
          <Link href="/recruitment/cycles/new" className={buttonClasses("primary", "sm")}>
            New cycle
          </Link>
        }
      />
      <Table>
        <THead>
          <tr>
            <TH>Title</TH>
            <TH>Track</TH>
            <TH>Status</TH>
          </tr>
        </THead>
        <tbody>
          {cycles.map((c) => (
            <TR key={c.id}>
              <TD>
                <Link href={`/recruitment/cycles/${c.id}`} className="font-medium text-foreground hover:text-brand-fg">
                  {c.title}
                </Link>
              </TD>
              <TD className="text-foreground-soft">{c.track}</TD>
              <TD>
                <Badge tone={statusTone[c.status as keyof typeof statusTone] ?? "default"}>{c.status}</Badge>
              </TD>
            </TR>
          ))}
          {cycles.length === 0 && (
            <TR>
              <TD colSpan={3} className="py-10 text-center text-subtle-foreground">
                No cycles yet. Create one to get started.
              </TD>
            </TR>
          )}
        </tbody>
      </Table>
    </div>
  );
}
