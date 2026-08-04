"use client";

import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";
import { TabRow, scrollActiveTabIntoView, type TabItem } from "@/platform/ui/tab-row";

/**
 * Persistent tab bar for a single cycle's workspace (Overview, Form,
 * Applicants, ...). Thin client wrapper over the shared TabRow primitive
 * (src/platform/ui/tab-row.tsx): TabRow is presentational only, so this
 * component owns usePathname (TabRow is not "use client") and the
 * cycle-specific active-matching rule, then hands rendering off.
 *
 * Segmented variant, not underline: the recruitment module's own tab row
 * ("Cycles", "My interviews") is already on screen above this one, and two
 * stacked underline rows would read as a mistake. Segmented reads as
 * subordinate to the module row.
 *
 * Active match starts from the same shape ModuleNav uses (exact match for
 * the root, prefix match for deeper hrefs -- see
 * src/platform/ui/module-nav.tsx), adapted for two things ModuleNav never has
 * to deal with:
 *
 * 1. Every item's href is built from the fixed three-segment cycle root
 *    ("/recruitment/cycles/<id>", see cycle-nav.ts), not a one-segment module
 *    root, so the "is this the root" check compares against that fixed depth
 *    instead of ModuleNav's ">1 segment" test.
 * 2. Form ("/builder"), Contract ("/builder/contract") and Quiz
 *    ("/builder/quiz") are three independent SIBLING tabs that happen to
 *    share a "/builder" URL prefix (an artifact of the route layout, not a
 *    parent/child relationship). Plain prefix matching would light up Form
 *    on every Contract or Quiz page. So a prefix match is suppressed when a
 *    more specific (longer-href) item in the same list also matches the
 *    pathname -- the most specific href always wins.
 *
 * Auto-scroll-to-active on narrow viewports copies module-nav.tsx's approach
 * verbatim: this row carries up to 12 items (more than any module nav), so it
 * overflows far more readily, and the ledger from the ModuleNav refactor
 * records that behaviour as must-preserve wherever TabRow is used.
 */
export function CycleNavTabs({ items }: { items: TabItem[] }) {
  const pathname = usePathname();
  const navRef = useRef<HTMLElement>(null);

  function isActive(item: TabItem): boolean {
    if (pathname === item.href) return true;
    const segments = item.href.replace(/^\//, "").split("/");
    if (segments.length <= 3) return false; // the cycle root (Overview): exact match only
    if (!pathname.startsWith(item.href)) return false;
    const isSuppressedBySibling = items.some(
      (other) => other.href.length > item.href.length && pathname.startsWith(other.href),
    );
    return !isSuppressedBySibling;
  }

  // Keep the active tab in view when the row scrolls horizontally on narrow
  // screens. This row carries up to 13 tabs, so it overflows far more readily
  // than any module nav.
  //
  // Must not use scrollIntoView: it scrolls every scrollable ancestor including
  // the document, which nudged the page on every cycle page load and raced
  // Playwright's click on Publish. See scrollActiveTabIntoView.
  useEffect(() => {
    scrollActiveTabIntoView(navRef.current);
  }, [pathname]);

  return (
    <TabRow
      variant="segmented"
      label="Cycle sections"
      items={items}
      isActive={isActive}
      navRef={navRef}
    />
  );
}
