"use client";

import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";
import { TabRow, type TabItem } from "./tab-row";

/** Inline to avoid a platform->platform/modules import under the lint rule. */
type NavItem = { label: string; href: string };

/**
 * Horizontal tab bar rendered under the page header area for module navigation.
 * Thin wrapper over the shared TabRow primitive (src/platform/ui/tab-row.tsx):
 * TabRow is presentational only, so this component owns usePathname (TabRow
 * is not "use client") and the module-specific active-matching rule, then
 * hands rendering off.
 * Active match: exact for the module root (e.g. "/admin"), startsWith for
 * deeper hrefs (e.g. "/admin/people", "/admin/terms").
 */
export function ModuleNav({ items }: { items: NavItem[] }) {
  const pathname = usePathname();
  const navRef = useRef<HTMLElement>(null);

  function isActive(item: TabItem): boolean {
    if (pathname === item.href) return true;
    // Only use prefix matching for hrefs that have a sub-segment (e.g. "/admin/people").
    // This prevents the root overview item from matching every sub-page.
    const segments = item.href.replace(/^\//, "").split("/");
    if (segments.length > 1 && pathname.startsWith(item.href)) return true;
    return false;
  }

  // When the row scrolls horizontally on narrow screens, keep the active tab in
  // view so the current section is always visible. `nearest` only scrolls the
  // tab row (never the page) and does nothing when the tab is already visible.
  // TabRow renders the active link itself (and marks it with aria-current), so
  // instead of holding a ref to a specific <a>, this reaches into the row via
  // the forwarded nav ref and finds the current one.
  useEffect(() => {
    navRef.current
      ?.querySelector<HTMLAnchorElement>('[aria-current="page"]')
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [pathname]);

  return (
    <TabRow
      variant="underline"
      label="Module"
      items={items}
      isActive={isActive}
      navRef={navRef}
    />
  );
}
