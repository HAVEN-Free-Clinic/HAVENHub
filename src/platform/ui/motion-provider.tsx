"use client";

import type { ReactNode } from "react";
import { MotionConfig } from "motion/react";
import { spring } from "./motion";

/**
 * App-wide Motion defaults. `reducedMotion="user"` follows the OS setting: when
 * reduced motion is on, transforms and layout animations become instant while
 * opacity fades still run, so nothing slides or scales but state changes stay
 * legible. The default transition is the standard spring, so a component that
 * forgets to pass one still moves like the rest of the app.
 */
export function MotionProvider({ children }: { children: ReactNode }) {
  return (
    <MotionConfig reducedMotion="user" transition={spring.default}>
      {children}
    </MotionConfig>
  );
}
