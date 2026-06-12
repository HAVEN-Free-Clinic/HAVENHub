"use client";

import { ProgressProvider } from "@bprogress/next/app";

/**
 * Global navigation progress bar. Mounted once in the root layout, it shows a
 * thin bar in the brand color across the top of the viewport whenever a
 * navigation starts (Link click or router.push) and hides it when the new route
 * commits -- giving instant "something is happening" feedback before the server
 * responds. Self-contained client state, so it is unaffected by the fact that
 * layouts do not re-render on soft navigation.
 */
export function TopProgressBar() {
  return (
    <ProgressProvider
      color="var(--color-brand)"
      height="3px"
      shallowRouting
      options={{ showSpinner: false }}
    />
  );
}
