import Link from "next/link";
import { requirePermission } from "@/platform/auth/session";
import { PageHeader } from "@/platform/ui/page-header";
import { Button } from "@/platform/ui/button";
import { Table, THead, TR, TH, TD } from "@/platform/ui/table";
import { getEhsDashboard } from "@/modules/ehs/services/status";
import { toggleEhsCompletionAction } from "./actions";

export default async function EhsDashboardPage() {
  const viewer = await requirePermission("volunteers.manage_compliance");
  const { trainings, rows } = await getEhsDashboard(viewer.personId);

  return (
    <>
      <PageHeader
        title="EHS training"
        description="Environmental Health and Safety training completion for your departments."
      />
      <div className="mt-6 max-w-fit space-y-4">
        <div className="mb-4">
          <Link href="/volunteers/ehs/manage">
            <Button variant="outline" size="sm">Manage trainings</Button>
          </Link>
        </div>

        {trainings.length === 0 ? (
          <p className="text-sm text-subtle-foreground">No active EHS trainings configured.</p>
        ) : (
          <Table>
            <THead>
              <TR className="border-t-0">
                <TH>Name</TH>
                <TH>Dept</TH>
                {trainings.map((t) => (
                  <TH key={t.id}>{t.name}</TH>
                ))}
              </TR>
            </THead>
            <tbody>
              {rows.map((row) => (
                <TR key={row.personId}>
                  <TD>{row.name}</TD>
                  <TD>{row.departmentCodes.join(", ")}</TD>
                  {row.cells.map((cell) => (
                    <TD key={cell.trainingId} className="text-center">
                      {cell.state === "NA" ? (
                        <span className="text-xs text-subtle-foreground">n/a</span>
                      ) : (
                        <form action={toggleEhsCompletionAction} className="inline">
                          <input type="hidden" name="personId" value={row.personId} />
                          <input type="hidden" name="trainingId" value={cell.trainingId} />
                          <input
                            type="hidden"
                            name="complete"
                            value={cell.state === "COMPLETE" ? "0" : "1"}
                          />
                          <Button
                            type="submit"
                            size="sm"
                            variant={cell.state === "COMPLETE" ? "primary" : "outline"}
                          >
                            {cell.state === "COMPLETE" ? "Complete" : "Mark"}
                          </Button>
                        </form>
                      )}
                    </TD>
                  ))}
                </TR>
              ))}
              {rows.length === 0 && (
                <TR>
                  <TD colSpan={trainings.length + 2} className="text-muted-foreground">
                    No active volunteers found for your departments.
                  </TD>
                </TR>
              )}
            </tbody>
          </Table>
        )}
      </div>
    </>
  );
}
