/**
 * EHS training dashboard: completion across every active member of the clinic.
 *
 * A clinic-wide READ, so either half of the compliance split admits (see
 * platform/compliance/access.ts). Marking completions, toggling EHS enrollment,
 * and the Manage trainings screen are writes and stay manage_compliance-only --
 * `isManager` below drops each of those controls for a view-only holder, who
 * reads the same grid with the state rendered as plain text. The actions
 * themselves re-check the permission (./actions.ts), so this is presentation.
 */
import Link from "next/link";
import { requireAnyPermission } from "@/platform/auth/session";
import { can } from "@/platform/rbac/engine";
import { PageHeader } from "@/platform/ui/page-header";
import { buttonClasses } from "@/platform/ui/button";
import { ConfirmButton } from "@/platform/ui/confirm-button";
import { SubmitButton } from "@/platform/ui/submit-button";
import { Table, THead, TR, TH, TD } from "@/platform/ui/table";
import { Pagination } from "@/platform/ui/pagination";
import { getEhsDashboard } from "@/platform/ehs/services/status";
import { toggleEhsCompletionAction, toggleAddedToEhsAction } from "./actions";
import { EmptyState } from "@/platform/ui/empty-state";

const PAGE_SIZE = 25;

export default async function EhsDashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>;
}) {
  const viewer = await requireAnyPermission([
    "volunteers.view_compliance",
    "volunteers.manage_compliance",
  ]);
  const isManager = await can(viewer.personId, "volunteers.manage_compliance");
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
        {isManager && (
          <div className="mb-4">
            <Link href="/volunteers/ehs/manage" className={buttonClasses("outline", "sm")}>
              Manage trainings
            </Link>
          </div>
        )}

        {trainings.length === 0 ? (
          <EmptyState inline>No active EHS trainings configured.</EmptyState>
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
                    {isManager ? (
                      <form action={toggleAddedToEhsAction} className="inline">
                        <input type="hidden" name="personId" value={row.personId} />
                        <input
                          type="hidden"
                          name="value"
                          value={row.addedToEhs ? "0" : "1"}
                        />
                        <SubmitButton
                          size="sm"
                          variant={row.addedToEhs ? "primary" : "outline"}
                          aria-label={`${row.addedToEhs ? "Remove from" : "Add to"} EHS: ${row.name}`}
                          pendingLabel="Saving…"
                        >
                          {row.addedToEhs ? "Added" : "Add"}
                        </SubmitButton>
                      </form>
                    ) : (
                      // Same fact, no affordance. "Not added" rather than a blank
                      // cell: the absence IS the answer this column exists to give.
                      <span className="text-xs text-foreground-soft">
                        {row.addedToEhs ? "Added" : "Not added"}
                      </span>
                    )}
                  </TD>
                  {row.cells.map((cell) => {
                    const trainingName = trainingNameById.get(cell.trainingId) ?? "training";
                    return (
                      <TD key={cell.trainingId} className="text-center">
                        {cell.state === "NA" ? (
                          <span className="text-xs text-subtle-foreground">n/a</span>
                        ) : !isManager ? (
                          // Read-only rendering of the same three states the
                          // buttons below convey, so the grid still answers
                          // "who has done what" without offering a write.
                          <span className="text-xs text-foreground-soft">
                            {cell.state === "COMPLETE" ? "✓ Complete" : "Incomplete"}
                          </span>
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
                            <SubmitButton
                              size="sm"
                              variant="outline"
                              aria-label={`Mark ${trainingName} complete for ${row.name}`}
                              pendingLabel="Saving…"
                            >
                              Mark
                            </SubmitButton>
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
