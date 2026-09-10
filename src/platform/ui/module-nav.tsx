"use client";

import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";
import { TabRow, scrollActiveTabIntoView, type TabItem } from "./tab-row";

/** Inline to avoid a platform->platform/modules import under the lint rule.
 *  `underTab` mirrors ModuleNavItem.underTab (src/platform/modules/types.ts). */
type NavItem = { label: string; href: string; underTab?: string };

/**
 * Horizontal tab bar rendered under the page header area for module navigation.
 * Thin wrapper over the shared TabRow primitive (src/platform/ui/tab-row.tsx):
 * TabRow is presentational only, so this component owns usePathname (TabRow
 * is not "use client") and the module-specific active-matching rule, then
 * hands rendering off.
 *
 * ## Active match: the most specific tab wins, and only one
 *
 * A tab matches when the pathname IS its href, or (for anything below the
 * module root) sits under it. The module root matches exactly and never by
 * prefix, or every sub-page would light it up.
 *
 * Of the tabs that match, exactly one is active: the one with the longest
 * href. That last rule is what lets a tab's href sit under another tab's path.
 * It could not before: on /admin/email/templates both "Email"
 * (/admin/email, by prefix) and "Email templates" (exactly) matched, so the row
 * carried two aria-current tabs and scrollActiveTabIntoView, which takes the
 * FIRST match, scrolled to the wrong one. The registry carried a standing
 * warning to keep tab hrefs flat because of it; three real pages
 * (/admin/email/templates, /volunteers/ehs/manage,
 * /schedule/attendings/credentialing) had no tab at all rather than move their
 * URL, so the rule is fixed here instead.
 *
 * The prefix test is `href + "/"` rather than a bare startsWith, so
 * /schedule/attendings does not claim a hypothetical /schedule/attendings-old.
 *
 * ## Folded pages
 *
 * An item with `underTab` is matched like any other but never drawn: when it
 * wins, the tab it names is marked instead. So /schedule/specialties lights
 * Attendings, though the two hrefs share no path, and a page can leave the row
 * without leaving the dropdown or Cmd+K, which read the same items.
 */
export function ModuleNav({ items }: { items: NavItem[] }) {
  const pathname = usePathname();
  const navRef = useRef<HTMLElement>(null);

  const match = items
    .filter((item) => {
      if (pathname === item.href) return true;
      const segments = item.href.replace(/^\//, "").split("/");
      return segments.length > 1 && pathname.startsWith(`${item.href}/`);
    })
    .reduce<NavItem | null>((best, item) => (best && best.href.length >= item.href.length ? best : item), null);
  const activeHref = match ? (match.underTab ?? match.href) : null;
  const tabs = items.filter((item) => !item.underTab);

  function isActive(item: TabItem): boolean {
    return item.href === activeHref;
  }

  // When the row scrolls horizontally on narrow screens, keep the active tab in
  // view so the current section is always visible. TabRow renders the active
  // link itself (and marks it with aria-current), so instead of holding a ref
  // to a specific <a>, this reaches into the row via the forwarded nav ref.
  //
  // This used to call scrollIntoView, under a comment asserting that `nearest`
  // scrolls only the row and never the page. That was wrong: scrollIntoView
  // scrolls every scrollable ancestor including the document. See
  // scrollActiveTabIntoView for what that cost.
  useEffect(() => {
    scrollActiveTabIntoView(navRef.current);
  }, [pathname]);

  return (
    <TabRow
      variant="underline"
      label="Module"
      items={tabs}
      isActive={isActive}
      navRef={navRef}
    />
  );
}
