import Link from "next/link";
import { requireModuleAccess } from "@/platform/auth/session";
import { can } from "@/platform/rbac/engine";
import { listCycles, listArchivedCycles } from "@/modules/recruitment/services/cycles";
import { PageHeader } from "@/platform/ui/page-header";
import { Table, THead, TR, TH, TD } from "@/platform/ui/table";
import { Badge } from "@/platform/ui/badge";
import { buttonClasses } from "@/platform/ui/button";

const statusTone = {
  DRAFT: "default",
  OPEN: "success",
  CLOSED: "warning",
  ARCHIVED: "default",
} as const;

export default async function RecruitmentPage() {
  // Sits above the cycles/ subtree layout, so it carries the recruitment.access
  // gate itself (the root recruitment layout is now only a session check).
  const session = await requireModuleAccess("recruitment");
  // Only cycle managers can actually create a cycle (createCycleAction enforces
  // recruitment.manage_cycles), so hide the affordance from reviewers who hold
  // recruitment.access but not manage_cycles -- they'd hit /no-access otherwise.
  const canManageCycles = await can(session.personId, "recruitment.manage_cycles");
  const [cycles, archivedCycles] = await Promise.all([listCycles(), listArchivedCycles()]);
  return (
    <div className="space-y-6">
      <PageHeader
        title="Recruitment cycles"
        description="Application cycles for volunteers and directors."
        action={
          canManageCycles ? (
            <Link href="/recruitment/cycles/new" className={buttonClasses("primary", "sm")}>
              New cycle
            </Link>
          ) : undefined
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
                {archivedCycles.length > 0 ? "No active cycles." : "No cycles yet. Create one to get started."}
              </TD>
            </TR>
          )}
        </tbody>
      </Table>

      {archivedCycles.length > 0 && (
        <details>
          <summary className="cursor-pointer select-none text-sm font-medium text-foreground hover:text-brand-fg">
            Archived ({archivedCycles.length})
          </summary>
          <div className="mt-3">
            <Table>
              <THead>
                <tr>
                  <TH>Title</TH>
                  <TH>Track</TH>
                  <TH>Status</TH>
                </tr>
              </THead>
              <tbody>
                {archivedCycles.map((c) => (
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
              </tbody>
            </Table>
          </div>
        </details>
      )}
    </div>
  );
}
