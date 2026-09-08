import { Skeleton } from "@/platform/ui/skeleton";
import { cardClasses } from "@/platform/ui/card";
import { Table, THead, TR, TH, TD } from "@/platform/ui/table";
import {
  complianceStatusLabel,
  ALL_COMPLIANCE_STATUSES,
} from "@/platform/compliance/labels";
import { FormRow, ROW_WIDTH } from "@/platform/ui/form";


/** The roster's column headings, in render order. Kept beside the real table so
 *  the placeholder reserves the same column widths and the swap does not shift
 *  the layout -- this page has measured CLS as high as 0.8. */
const COLUMNS = [
  "Name",
  "Departments",
  "Status",
  "Training",
  "Learning",
  "EHS",
  "Cleared",
  "Completed",
  "Expires",
  "Verified",
  "",
];

/** Read from the shared vocabulary, not retyped: the skeleton carries the REAL
 *  labels so the swap does not shift the layout, which only holds while the two
 *  agree. They had already drifted in casing. Order matches the live grid. */
const SUMMARY_LABELS = ALL_COMPLIANCE_STATUSES.map((s) => complianceStatusLabel(s, "staff").label);

/** A stat card with its real label but a placeholder figure. Uses cardClasses
 *  and the same type scale as StatCard so the height matches to the pixel. */
function StatCardSkeleton({ label }: { label: string }) {
  return (
    <div className={cardClasses()}>
      <div className="flex h-8 items-center">
        <Skeleton className="h-6 w-10" />
      </div>
      <p className="mt-1 text-xs uppercase tracking-wider text-subtle-foreground">{label}</p>
    </div>
  );
}

/**
 * Loading placeholder for everything below the master compliance page header:
 * the summary cards, the filter bar and the roster table.
 *
 * The whole point is that nothing in here is interactive. The route's dead
 * clicks cluster five to fifteen seconds after load, on controls that had
 * painted but were not wired up yet; a placeholder that looks like a control
 * but is a plain div collects the same click harmlessly and, unlike the real
 * control, visibly says "loading". So the filter fields are Skeleton blocks
 * rather than real <Input>/<Select> elements, and the rows carry no buttons.
 */
export function MasterComplianceSkeleton() {
  return (
    <div role="status" aria-label="Loading the master compliance roster">
      <span className="sr-only">Loading the master compliance roster</span>

      {/* Summary stat cards */}
      <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {SUMMARY_LABELS.map((label) => (
          <StatCardSkeleton key={label} label={label} />
        ))}
      </div>

      {/* Clearance summary */}
      <div className="mt-3 grid grid-cols-2 gap-3">
        <StatCardSkeleton label="Fully cleared" />
        <StatCardSkeleton label="Missing EHS" />
      </div>

      {/* Filter bar. The column widths come from ROW_WIDTH, the same table the
          real FilterField reads, so the skeleton cannot drift away from the bar
          it stands in for. */}
      <FormRow className="mt-6">
        <div className={ROW_WIDTH.grow}>
          <Skeleton className="h-3 w-14" />
          <Skeleton className="mt-1.5 h-9 w-full" />
        </div>
        <div className={ROW_WIDTH.wide}>
          <Skeleton className="h-3 w-20" />
          <Skeleton className="mt-1.5 h-9 w-full" />
        </div>
        <div className={ROW_WIDTH.control}>
          <Skeleton className="h-3 w-12" />
          <Skeleton className="mt-1.5 h-9 w-full" />
        </div>
        <Skeleton className="h-8 w-16" />
      </FormRow>

      {/* Results */}
      <div className="mt-4">
        <Skeleton className="mb-3 h-4 w-24" />
        <Table>
          <THead>
            <TR>
              {COLUMNS.map((c, i) => (
                <TH key={i}>{c}</TH>
              ))}
            </TR>
          </THead>
          <tbody>
            {Array.from({ length: 8 }).map((_, row) => (
              <TR key={row}>
                <TD>
                  <Skeleton className="h-4 w-36" />
                  <Skeleton className="mt-1.5 h-3 w-44" />
                </TD>
                {COLUMNS.slice(1).map((_c, col) => (
                  <TD key={col}>
                    <Skeleton className="h-4 w-16" />
                  </TD>
                ))}
              </TR>
            ))}
          </tbody>
        </Table>
      </div>
    </div>
  );
}
