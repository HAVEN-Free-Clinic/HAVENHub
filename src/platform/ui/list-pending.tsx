"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useLinkStatus } from "next/link";
import { cx } from "./cx";

/**
 * Pending feedback for the navigations that have none.
 *
 * Filtering, paging and term switching are all `?`-only links onto the SAME
 * route. They do not remount a Suspense boundary, so `loading.tsx` never fires,
 * and they are precisely the navigations that wait on a database round trip.
 * Until now the only feedback was the 3px top bar, a gap `top-progress-bar.tsx`
 * already documents in its own comment ("there is no per-table skeleton behind
 * them"). Measured before this shipped: 14 paginated pages, zero of them with
 * any pending affordance.
 *
 * WHY A PROVIDER RATHER THAN A LOCAL HOOK. `useLinkStatus` only reports on the
 * `<Link>` it is rendered inside, so a list body cannot ask "is any of my
 * pagination pending?" on its own. Rather than rewire every list page, the two
 * SHARED primitives report into one context mounted high in the tree:
 *
 *   - `Pagination` renders `<LinkPendingReporter />` inside each `<Link>`.
 *   - `NavForm` reports its own `useTransition` pending state. It cannot use
 *     `useFormStatus`: it calls preventDefault() and router.push()es, and
 *     useFormStatus only tracks a form whose `action` is a function.
 *
 * A list page then wraps its rows in `<PendingDim>` and needs to know nothing
 * about either mechanism.
 *
 * The context tolerates having no provider: a `<Link>` elsewhere in the app that
 * happens to contain a reporter reports into a no-op, rather than throwing.
 */

type ListPendingValue = {
  pending: boolean;
  /** Reference-counted, because several reporters can be live at once. */
  report: (active: boolean) => void;
};

const NOOP: ListPendingValue = { pending: false, report: () => {} };

const ListPendingContext = createContext<ListPendingValue>(NOOP);

export function ListPendingProvider({ children }: { children: ReactNode }) {
  const [count, setCount] = useState(0);

  // Stable identity: reporters depend on this in an effect, and a new function
  // each render would re-run every one of them on every render.
  const report = useCallback((active: boolean) => {
    setCount((c) => Math.max(0, c + (active ? 1 : -1)));
  }, []);

  const value = useMemo(() => ({ pending: count > 0, report }), [count, report]);

  return <ListPendingContext.Provider value={value}>{children}</ListPendingContext.Provider>;
}

/** True while any reporting link or filter form is mid-navigation. */
export function useListPending(): boolean {
  return useContext(ListPendingContext).pending;
}

/**
 * Report a pending state from a client component that already knows its own.
 * Used by NavForm, which owns a useTransition rather than a Link.
 */
export function useReportListPending(active: boolean): void {
  const { report } = useContext(ListPendingContext);
  useEffect(() => {
    if (!active) return;
    report(true);
    return () => report(false);
  }, [active, report]);
}

/**
 * Renders nothing; reports the enclosing `<Link>`'s pending state.
 *
 * MUST be rendered inside a `<Link>`: useLinkStatus reads that link's context.
 * Outside one it simply never goes pending.
 */
export function LinkPendingReporter() {
  const { pending } = useLinkStatus();
  useReportListPending(pending);
  return null;
}

/**
 * Dims and disables its children while a list navigation is in flight, so stale
 * rows cannot be read as current and a second click cannot queue another
 * navigation on top of the first.
 *
 * `aria-busy` carries the same information to assistive tech, which the visual
 * dim alone would not. Pointer events are removed rather than the controls being
 * individually disabled: the rows are server-rendered markup this wrapper knows
 * nothing about.
 */
export function PendingDim({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  const pending = useListPending();
  return (
    <div
      aria-busy={pending || undefined}
      className={cx(
        "transition-opacity duration-150 motion-reduce:transition-none",
        pending && "pointer-events-none opacity-50",
        className,
      )}
    >
      {children}
    </div>
  );
}
