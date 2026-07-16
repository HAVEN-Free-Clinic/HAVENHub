import Link from "next/link";
import { requirePermission } from "@/platform/auth/session";
import { PageHeader } from "@/platform/ui/page-header";
import { Button, buttonClasses } from "@/platform/ui/button";
import { ConfirmButton } from "@/platform/ui/confirm-button";
import { Table, THead, TR, TH, TD } from "@/platform/ui/table";
import { Pagination } from "@/platform/ui/pagination";
import { getEhsDashboard } from "@/platform/ehs/services/status";
import { toggleEhsCompletionAction, toggleAddedToEhsAction } from "./actions";

const PAGE_SIZE = 25;

export default async function EhsDashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>;
}) {
  await requirePermission("volunteers.manage_compliance");
  const { trainings, rows } = await getEhsDashboard();
  const trainingNameById = new Map(trainings.map((t) => [t.id, t.name]));
  const sp = await searchParams;

  // Render-level pagination: bounds the DOM (one form per row plus one per
  // training cell) for large active-volunteer rosters. Mirrors master/page.tsx.
  const pageCount = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const page = Math.min(Math.max(1, parseInt(sp.page ?? "1", 10) || 1), pageCount);
  const pageRows = rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const buildHref = (targetPage: number) => `/volunteers/ehs?page=${targetPage}`;

  return (
    <>
      <PageHeader
        title="EHS training"
        description="Environmental Health and Safety training completion."
      />
      <div className="mt-6 max-w-fit space-y-4">
        <div className="mb-4">
          <Link href="/volunteers/ehs/manage" className={buttonClasses("outline", "sm")}>
            Manage trainings
          </Link>
        </div>

        {trainings.length === 0 ? (
          <p className="text-sm text-subtle-foreground">No active EHS trainings configured.</p>
        ) : (
          <>
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
              {pageRows.map((row) => (
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
                        aria-label={`${row.addedToEhs ? "Remove from" : "Add to"} EHS: ${row.name}`}
                      >
                        {row.addedToEhs ? "Added" : "Add"}
                      </Button>
                    </form>
                  </TD>
                  {row.cells.map((cell) => {
                    const trainingName = trainingNameById.get(cell.trainingId) ?? "training";
                    return (
                      <TD key={cell.trainingId} className="text-center">
                        {cell.state === "NA" ? (
                          <span className="text-xs text-subtle-foreground">n/a</span>
                        ) : cell.state === "COMPLETE" ? (
                          // Unmarking hard-deletes the completion and its provenance, so
                          // guard it behind a two-click confirm (was a single click on a
                          // button whose label described the state, not the action).
                          <form action={toggleEhsCompletionAction} className="inline">
                            <input type="hidden" name="personId" value={row.personId} />
                            <input type="hidden" name="trainingId" value={cell.trainingId} />
                            <input type="hidden" name="complete" value="0" />
                            <ConfirmButton
                              size="sm"
                              label="✓ Complete"
                              confirmLabel="Unmark?"
                              aria-label={`Unmark ${trainingName} complete for ${row.name}`}
                            />
                          </form>
                        ) : (
                          <form action={toggleEhsCompletionAction} className="inline">
                            <input type="hidden" name="personId" value={row.personId} />
                            <input type="hidden" name="trainingId" value={cell.trainingId} />
                            <input type="hidden" name="complete" value="1" />
                            <Button
                              type="submit"
                              size="sm"
                              variant="outline"
                              aria-label={`Mark ${trainingName} complete for ${row.name}`}
                            >
                              Mark
                            </Button>
                          </form>
                        )}
                      </TD>
                    );
                  })}
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
          <Pagination page={page} pageCount={pageCount} hrefFor={buildHref} />
          </>
        )}
      </div>
    </>
  );
}
