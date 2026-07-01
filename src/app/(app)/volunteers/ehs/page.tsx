import Link from "next/link";
import { requirePermission } from "@/platform/auth/session";
import { PageHeader } from "@/platform/ui/page-header";
import { Button } from "@/platform/ui/button";
import { Table, THead, TR, TH, TD } from "@/platform/ui/table";
import { getEhsDashboard } from "@/platform/ehs/services/status";
import { toggleEhsCompletionAction, toggleAddedToEhsAction } from "./actions";

export default async function EhsDashboardPage() {
  await requirePermission("volunteers.manage_compliance");
  const { trainings, rows } = await getEhsDashboard();

  return (
    <>
      <PageHeader
        title="EHS training"
        description="Environmental Health and Safety training completion."
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
                <TH>Added to EHS?</TH>
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
                  <TD className="text-center">
                    <form action={toggleAddedToEhsAction} className="inline">
                      <input type="hidden" name="personId" value={row.personId} />
                      <input
                        type="hidden"
                        name="value"
                        value={row.addedToEhs ? "0" : "1"}
                      />
                      <Button
                        type="submit"
                        size="sm"
                        variant={row.addedToEhs ? "primary" : "outline"}
                      >
                        {row.addedToEhs ? "Added" : "Add"}
                      </Button>
                    </form>
                  </TD>
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
                  <TD colSpan={trainings.length + 3} className="text-muted-foreground">
                    No active volunteers found.
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
