import { Skeleton } from "@/platform/ui/skeleton";

/**
 * Loading placeholder for the master compliance view. Mirrors the stat-card
 * grid, filter bar, and roster table so the streamed content swaps in without a
 * layout shift.
 *
 * It renders inert blocks, not the real controls, on purpose: the roster's
 * data takes seconds to resolve, and the old fully-blocking render painted live
 * View / Filter buttons before hydration wired them up, so early clicks landed
 * dead. A skeleton gives the eye nothing clickable until the real table streams
 * in and is interactive.
 */
export function MasterComplianceSkeleton() {
  return (
    <div role="status" aria-label="Loading master compliance view">
      <span className="sr-only">Loading master compliance view</span>

      {/* Summary stat cards */}
      <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-20 rounded-2xl" />
        ))}
      </div>

      {/* Clearance summary */}
      <div className="mt-3 grid grid-cols-2 gap-3">
        {Array.from({ length: 2 }).map((_, i) => (
          <Skeleton key={i} className="h-20 rounded-2xl" />
        ))}
      </div>

      {/* Filter bar */}
      <div className="mt-6 flex flex-wrap items-end gap-3">
        <Skeleton className="h-9 min-w-48 flex-1 rounded-lg" />
        <Skeleton className="h-9 w-52 rounded-lg" />
        <Skeleton className="h-9 w-44 rounded-lg" />
        <Skeleton className="h-9 w-20 rounded-lg" />
      </div>

      {/* Results table */}
      <div className="mt-4">
        <Skeleton className="mb-3 h-4 w-28" />
        <div className="flex flex-col gap-2">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-12 w-full rounded-lg" />
          ))}
        </div>
      </div>
    </div>
  );
}
