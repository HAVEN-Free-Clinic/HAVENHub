"use client";

import type { ReactNode } from "react";
import { ProgressProvider } from "@bprogress/next/app";

/**
 * Global navigation progress bar. Wraps the app in the root layout: it shows a
 * thin bar in the brand color across the top of the viewport whenever a
 * navigation starts (a <Link> click or browser back/forward) and hides it when
 * the new route commits -- giving instant "something is happening" feedback
 * before the server responds. The bar element is injected by the library; this
 * provider only configures it and supplies the progress context to children.
 * Self-contained client state, so it is unaffected by the fact that layouts do
 * not re-render on soft navigation.
 */
export function TopProgressBar({ children }: { children?: ReactNode } = {}) {
  return (
    <ProgressProvider
      color="var(--color-brand)"
      height="3px"
      shallowRouting
      options={{ showSpinner: false }}
    >
      {children}
    </ProgressProvider>
  );
}
