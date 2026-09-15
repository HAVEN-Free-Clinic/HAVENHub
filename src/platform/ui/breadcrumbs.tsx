"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { buildBreadcrumbs, type BreadcrumbModule } from "./breadcrumb-trail";
import { useBreadcrumbLeaf, useBreadcrumbOverride } from "./breadcrumb-context";
import { SHELL_WIDTH } from "./shell-width";

/** Compare two app paths ignoring a trailing slash (buildBreadcrumbs strips one). */
function samePath(href: string, pathname: string) {
  const strip = (p: string) => p.replace(/\/+$/, "") || "/";
  return strip(href) === strip(pathname);
}

export function Breadcrumbs({ modules }: { modules: BreadcrumbModule[] }) {
  const pathname = usePathname();
  // A page may supply a rich trail (entity names, dynamic sections) via context.
  // Otherwise fall back to the route-derived trail from the module registry.
  const override = useBreadcrumbOverride(pathname);
  // Most detail pages need only the record's name; the registry already knows
  // the rest of the trail. See SetBreadcrumbLeaf.
  const leaf = useBreadcrumbLeaf(pathname);
  const crumbs = override ?? buildBreadcrumbs(pathname, modules, leaf ?? undefined);

  // Nothing useful to show on the hub root (just "Hub").
  if (crumbs.length <= 1) return null;

  return (
    // No solid band or border: the breadcrumb rides directly on the canvas as a
    // quiet label beneath the floating glass nav (a full-width white strip would
    // read as an orphaned band wedged between the pill and the content).
    <nav aria-label="Breadcrumb" className={`mx-auto w-full ${SHELL_WIDTH} px-6 pt-4 pb-1`}>
      <ol className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
        {crumbs.map((crumb, i) => {
          const isLast = i === crumbs.length - 1;
          // The last crumb is the current page only when it actually points at
          // it. Position alone is not enough: buildBreadcrumbs deliberately
          // ends a detail page's trail on the LINKED PARENT section ("no leaf;
          // the section link is the escape"), so treating last as current
          // stripped the href from the one crumb that existed to be clicked,
          // leaving detail pages with no way back out and putting
          // aria-current="page" on an ancestor.
          //
          // Comparing against the pathname instead keeps both shapes right:
          // a recruitment trail (breadcrumbs.ts) gives every crumb an href
          // including the current page's own, and that one still resolves to
          // plain current-page text rather than a self-link.
          const isCurrent = isLast && (!crumb.href || samePath(crumb.href, pathname));
          return (
            <li key={`${crumb.label}-${i}`} className="flex items-center gap-1.5">
              {crumb.href && !isCurrent ? (
                <Link
                  href={crumb.href}
                  className="rounded-sm transition-colors hover:text-brand-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
                >
                  {crumb.label}
                </Link>
              ) : (
                <span
                  aria-current={isCurrent ? "page" : undefined}
                  className={isCurrent ? "font-medium text-foreground-soft" : undefined}
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
