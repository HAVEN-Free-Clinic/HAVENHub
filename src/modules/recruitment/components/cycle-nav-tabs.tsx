"use client";

import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";
import { TabRow, scrollActiveTabIntoView, type TabItem } from "@/platform/ui/tab-row";
import { CYCLE_NAV_GROUPS, type CycleNavItem } from "../cycle-nav";

/**
 * A single cycle's workspace nav: a row of workflow stages (Setup, Review,
 * Accepted, Settings) and, under it, the tabs of the stage you are in.
 *
 * It used to be one row of up to twelve tabs, in no workflow order, that
 * overflowed on anything narrower than a wide laptop. The pages and their URLs
 * are unchanged; only the arrangement is. A stage links to the first of its
 * tabs the viewer can open (cycle-nav.ts decides which those are).
 *
 * Two rows only when they earn it: the stage row is skipped when the viewer
 * has a single stage (a committee scorer sees Review alone), and the tab row
 * is skipped when the current stage holds a single page (Settings is just the
 * overview), so neither row ever repeats the other.
 *
 * Variants: the recruitment module's own row above is underline, so the stage
 * row is segmented, reading as a level below it, and the tab row is underline
 * again beneath that. The tab row keeps the "Cycle sections" landmark name.
 *
 * Active match starts from the same shape ModuleNav uses (exact match for the
 * root, prefix match for deeper hrefs -- see src/platform/ui/module-nav.tsx),
 * adapted for two things ModuleNav never has to deal with:
 *
 * 1. Every item's href is built from the fixed three-segment cycle root
 *    ("/recruitment/cycles/<id>"), not a one-segment module root, so the "is
 *    this the root" check compares against that fixed depth.
 * 2. Form ("/builder"), Contract ("/builder/contract") and Quiz
 *    ("/builder/quiz") are SIBLING tabs that happen to share a "/builder"
 *    prefix (an artifact of the route layout). So a prefix match is suppressed
 *    when a more specific (longer-href) item also matches the pathname.
 */
export function CycleNavTabs({ items }: { items: CycleNavItem[] }) {
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

  const groups = CYCLE_NAV_GROUPS.map((g) => ({ ...g, items: items.filter((i) => i.group === g.key) })).filter(
    (g) => g.items.length > 0,
  );
  const activeItem = items.find(isActive) ?? null;
  const activeGroup = activeItem ? (groups.find((g) => g.key === activeItem.group) ?? null) : null;

  const stageTabs: TabItem[] = groups.map((g) => ({ label: g.label, href: g.items[0].href }));
  // A single stage needs no stage row; its tabs are the whole nav.
  const showStages = groups.length > 1;
  const sectionTabs = showStages ? (activeGroup?.items ?? []) : items;
  const showSections = sectionTabs.length > 1 || (!showStages && sectionTabs.length > 0);

  // Keep the active tab in view when the tab row scrolls horizontally on narrow
  // screens. Must not use scrollIntoView: it scrolls every scrollable ancestor
  // including the document, which nudged the page on every cycle page load and
  // raced Playwright's click on Publish. See scrollActiveTabIntoView.
  useEffect(() => {
    scrollActiveTabIntoView(navRef.current);
  }, [pathname]);

  return (
    <div className="space-y-3">
      {showStages && (
        <TabRow
          variant="segmented"
          label="Cycle stages"
          items={stageTabs}
          isActive={(tab) => tab.label === activeGroup?.label}
        />
      )}
      {showSections && (
        <TabRow variant="underline" label="Cycle sections" items={sectionTabs} isActive={isActive} navRef={navRef} />
      )}
    </div>
  );
}
