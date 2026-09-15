"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { scrollActiveTabIntoView } from "@/platform/ui/tab-row";

/**
 * Keeps the `aria-current="page"` link inside a horizontally scrolling strip in
 * view, for the clinic date strip on a phone. The strip is one scrolling row
 * there, so without this a date late in the term would arrive selected but off
 * the right-hand edge.
 *
 * Uses scrollActiveTabIntoView rather than Element.scrollIntoView, for the
 * reason written up on that function: scrollIntoView moves every scrollable
 * ancestor, the page included. The strip is the first <nav> inside.
 */
export function SelectedIntoView({ selectedKey, children }: { selectedKey: string | null; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    scrollActiveTabIntoView(ref.current?.querySelector("nav") ?? null);
  }, [selectedKey]);
  return <div ref={ref}>{children}</div>;
}
