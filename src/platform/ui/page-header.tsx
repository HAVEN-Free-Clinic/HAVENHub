import type { ReactNode } from "react";

/**
 * Page-level heading, with separate slots for what a page IS and what it DOES.
 *
 * The single `action` slot used to carry both. Across the app it held a primary
 * button on eight pages, a status badge on five, and on two something else
 * again, so the top-right of a page, the position users learn as "the thing
 * this page lets me do", was sometimes the action and sometimes a read-only
 * fact.
 *
 * `status` is the record's own state and renders as a chip beside the title,
 * where it reads as part of the record's identity. `action` stays on the right
 * for controls. A page may use either, both, or neither.
 */
export function PageHeader({
  title,
  description,
  status,
  action,
}: {
  title: string;
  description?: string;
  /** Read-only state for the record this page is about, typically a Badge. */
  status?: ReactNode;
  /** Controls: a primary Button, or a link that acts like one. */
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-2xl font-bold tracking-tight">{title}</h1>
          {status}
        </div>
        {description && (
          <p className="mt-1 text-sm text-muted-foreground">{description}</p>
        )}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}
