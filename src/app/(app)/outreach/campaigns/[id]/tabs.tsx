"use client";

import { TabRow, type TabItem } from "@/platform/ui/tab-row";

export type EditorTab = "compose" | "audience" | "review";

const LABELS: Record<EditorTab, string> = {
  compose: "Compose",
  audience: "Audience",
  review: "Review & send",
};

/**
 * Compose / Audience / Review tab switcher for the campaign editor.
 *
 * Presentational only -- every section stays mounted in the page regardless
 * of which tab is active (see page.tsx), so this component's job is limited
 * to rendering the three links and highlighting the current one. Reflecting
 * the active tab in `?tab=` (rather than local client state) is what lets a
 * save round-trip -- the compose form redirects back to this same URL --
 * return the sender to the tab they were on, and what lets every input stay
 * associated with the one compose form no matter which panel is showing.
 */
export function EditorTabs({ active, basePath }: { active: EditorTab; basePath: string }) {
  const items: TabItem[] = (["compose", "audience", "review"] as const).map((tab) => ({
    label: LABELS[tab],
    href: `${basePath}?tab=${tab}`,
  }));

  function isActive(item: TabItem): boolean {
    const [, query = ""] = item.href.split("?");
    return new URLSearchParams(query).get("tab") === active;
  }

  return <TabRow variant="underline" label="Campaign editor sections" items={items} isActive={isActive} />;
}
