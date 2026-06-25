"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { buildBreadcrumbs, type BreadcrumbModule } from "./breadcrumb-trail";
import { useBreadcrumbOverride } from "./breadcrumb-context";

export function Breadcrumbs({ modules }: { modules: BreadcrumbModule[] }) {
  const pathname = usePathname();
  // A page may supply a rich trail (entity names, dynamic sections) via context.
  // Otherwise fall back to the route-derived trail from the module registry.
  const override = useBreadcrumbOverride(pathname);
  const crumbs = override ?? buildBreadcrumbs(pathname, modules);

  // Nothing useful to show on the hub root (just "Hub").
  if (crumbs.length <= 1) return null;

  return (
    // No solid band or border: the breadcrumb rides directly on the canvas as a
    // quiet label beneath the floating glass nav (a full-width white strip would
    // read as an orphaned band wedged between the pill and the content).
    <nav aria-label="Breadcrumb" className="mx-auto w-full max-w-6xl px-6 pt-4 pb-1">
      <ol className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
        {crumbs.map((crumb, i) => {
          const isLast = i === crumbs.length - 1;
          return (
            <li key={`${crumb.label}-${i}`} className="flex items-center gap-1.5">
              {crumb.href && !isLast ? (
                <Link
                  href={crumb.href}
                  className="rounded-sm transition-colors hover:text-brand-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
                >
                  {crumb.label}
                </Link>
              ) : (
                <span
                  aria-current={isLast ? "page" : undefined}
                  className={isLast ? "font-medium text-foreground-soft" : undefined}
                >
                  {crumb.label}
                </span>
              )}
              {!isLast && (
                <span aria-hidden className="text-subtle-foreground">
                  &rsaquo;
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
