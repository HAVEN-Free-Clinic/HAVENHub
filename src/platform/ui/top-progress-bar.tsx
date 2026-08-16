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
 *
 * Deliberately does NOT pass `shallowRouting` (audit 14). Despite the name, that
 * flag does not mean "also cover shallow routes": inside the library it reads
 * `shallowRouting && isSameURLWithoutSearch(target, current) && disableSameURL ->
 * return`, i.e. it SUPPRESSES the bar for any navigation that keeps the same path
 * and changes only the query string. In this app that is not a rare edge, it is the
 * slow path: pagination, column sorting, filter and tab changes, and term/view
 * switching are all `?`-only links onto the same route, and they are the
 * navigations that actually wait on a database round trip. With the flag set, the
 * whole app went dead-silent for exactly those clicks, because this bar is the only
 * loading indicator they have (there is no per-table skeleton behind them). The
 * library's own `disableSameURL` default still suppresses the bar for a navigation
 * to the byte-identical URL, which is the case genuinely worth skipping.
 */
export function TopProgressBar({ children }: { children?: ReactNode } = {}) {
  return (
    <ProgressProvider
      color="var(--color-brand)"
      height="3px"
      options={{ showSpinner: false }}
    >
      {children}
    </ProgressProvider>
  );
}
