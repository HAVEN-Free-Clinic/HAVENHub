"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/** Inline to avoid a platform->platform/modules import under the lint rule. */
type NavItem = { label: string; href: string };

/**
 * Horizontal tab bar rendered under the page header area for module navigation.
 * Uses usePathname for reliable active-link detection in client components.
 * Active match: exact for the module root (e.g. "/admin"), startsWith for
 * deeper hrefs (e.g. "/admin/people", "/admin/terms").
 */
export function ModuleNav({ items }: { items: NavItem[] }) {
  const pathname = usePathname();

  function isActive(href: string): boolean {
    if (pathname === href) return true;
    // Only use prefix matching for hrefs that have a sub-segment (e.g. "/admin/people").
    // This prevents the root overview item from matching every sub-page.
    const segments = href.replace(/^\//, "").split("/");
    if (segments.length > 1 && pathname.startsWith(href)) return true;
    return false;
  }

  return (
    <nav
      aria-label="Module"
      className="flex gap-6 border-b border-border text-sm"
    >
      {items.map((item) => (
        <Link
          key={item.href}
          href={item.href}
          className={
            isActive(item.href)
              ? "border-b-2 border-brand pb-2 text-brand-fg font-medium"
              : "pb-2 text-muted-foreground hover:text-foreground"
          }
        >
          {item.label}
        </Link>
      ))}
    </nav>
  );
}
