"use client";

import { useEffect, useRef } from "react";
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
  const activeRef = useRef<HTMLAnchorElement>(null);

  function isActive(href: string): boolean {
    if (pathname === href) return true;
    // Only use prefix matching for hrefs that have a sub-segment (e.g. "/admin/people").
    // This prevents the root overview item from matching every sub-page.
    const segments = href.replace(/^\//, "").split("/");
    if (segments.length > 1 && pathname.startsWith(href)) return true;
    return false;
  }

  // When the row scrolls horizontally on narrow screens, keep the active tab in
  // view so the current section is always visible. `nearest` only scrolls the
  // tab row (never the page) and does nothing when the tab is already visible.
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [pathname]);

  return (
    <nav
      aria-label="Module"
      // Scroll the tab row within its own box on narrow screens instead of
      // letting it stretch the page past the viewport. Scrollbar hidden for a
      // clean tab-bar look; tabs stay swipe/trackpad scrollable.
      className="flex gap-6 overflow-x-auto border-b border-border text-sm [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
    >
      {items.map((item) => {
        const active = isActive(item.href);
        return (
          <Link
            key={item.href}
            ref={active ? activeRef : undefined}
            href={item.href}
            className={
              active
                ? "shrink-0 whitespace-nowrap border-b-2 border-brand pb-2 text-brand-fg font-medium"
                : "shrink-0 whitespace-nowrap pb-2 text-muted-foreground hover:text-foreground"
            }
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
