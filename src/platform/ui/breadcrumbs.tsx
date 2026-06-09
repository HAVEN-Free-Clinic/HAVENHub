"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { buildBreadcrumbs, type BreadcrumbModule } from "./breadcrumb-trail";

export function Breadcrumbs({
  modules,
  leafLabel,
}: {
  modules: BreadcrumbModule[];
  leafLabel?: string;
}) {
  const pathname = usePathname();
  const crumbs = buildBreadcrumbs(pathname, modules, leafLabel);

  // Nothing useful to show on the hub root (just "Hub").
  if (crumbs.length <= 1) return null;

  return (
    <div className="border-b border-slate-200 bg-white">
      <nav aria-label="Breadcrumb" className="mx-auto max-w-6xl px-6 py-2">
        <ol className="flex flex-wrap items-center gap-1.5 text-xs text-slate-500">
          {crumbs.map((crumb, i) => {
            const isLast = i === crumbs.length - 1;
            return (
              <li key={`${crumb.label}-${i}`} className="flex items-center gap-1.5">
                {crumb.href && !isLast ? (
                  <Link
                    href={crumb.href}
                    className="rounded-sm transition-colors hover:text-brand focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
                  >
                    {crumb.label}
                  </Link>
                ) : (
                  <span
                    aria-current={isLast ? "page" : undefined}
                    className={isLast ? "font-medium text-slate-700" : undefined}
                  >
                    {crumb.label}
                  </span>
                )}
                {!isLast && (
                  <span aria-hidden className="text-slate-300">
                    &rsaquo;
                  </span>
                )}
              </li>
            );
          })}
        </ol>
      </nav>
    </div>
  );
}
