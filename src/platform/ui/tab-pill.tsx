"use client";

import { motion } from "motion/react";
import { spring } from "./motion";

/**
 * The active-tab indicator: the white pill behind a segmented tab, or the brand
 * underline beneath an underline tab. It carries a `layoutId`, so when the
 * active tab changes while the row stays mounted (a persistent module nav, a
 * client-side tab switch) the indicator glides from the old tab to the new one
 * instead of jumping. Where the row remounts with the page, it simply appears.
 *
 * Split out of TabRow because Motion needs the client and TabRow must stay
 * server-renderable. It takes only strings, so nothing crosses the boundary
 * that could become a client-reference proxy.
 *
 * The parent link must be `relative isolate`: the pill is absolutely placed
 * against it, and `isolate` keeps the segmented pill's -z-10 behind the label
 * without slipping under the track.
 */
export function TabPill({
  layoutId,
  variant,
}: {
  layoutId: string;
  variant: "underline" | "segmented";
}) {
  return (
    <motion.span
      layoutId={layoutId}
      transition={spring.default}
      aria-hidden
      data-tab-indicator=""
      className={
        variant === "segmented"
          ? "absolute inset-0 -z-10 rounded-lg bg-surface shadow-sm"
          : "absolute inset-x-0 bottom-0 h-0.5 rounded-full bg-brand"
      }
    />
  );
}
