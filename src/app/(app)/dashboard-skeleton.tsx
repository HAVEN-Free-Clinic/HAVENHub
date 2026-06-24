import { Skeleton } from "@/platform/ui/skeleton";

/**
 * Loading placeholder for the hub dashboard. Mirrors HubPage's two-column grid
 * (main column: greeting, next-shift card, quick actions, module tiles; side
 * rail: clinic channel + compliance) so the real content swaps in without a
 * layout shift. Rendered by (app)/loading.tsx while the page's data resolves;
 * the persistent shell stays mounted, so only this body region is replaced.
 */
export function DashboardSkeleton() {
  return (
    <div role="status" aria-label="Loading your dashboard">
      <span className="sr-only">Loading your dashboard</span>
      <div className="grid items-start gap-6 lg:grid-cols-[1fr_340px]">
        {/* Main column */}
        <div className="min-w-0">
          {/* Greeting */}
          <div className="mb-6">
            <Skeleton className="h-3 w-40" />
            <Skeleton className="mt-3 h-9 w-72 max-w-full" />
            <Skeleton className="mt-3 h-4 w-96 max-w-full" />
          </div>

          {/* Next-shift card */}
          <Skeleton className="h-44 w-full rounded-2xl" />

          {/* Quick actions */}
          <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-16 rounded-xl" />
            ))}
          </div>

          {/* Modules */}
          <Skeleton className="mt-9 mb-3 h-5 w-28" />
          <div className="grid gap-3 sm:grid-cols-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-24 rounded-2xl" />
            ))}
          </div>
        </div>

        {/* Side rail */}
        <aside className="flex flex-col gap-4">
          <Skeleton className="h-28 rounded-2xl" />
          <Skeleton className="h-40 rounded-2xl" />
        </aside>
      </div>
    </div>
  );
}
