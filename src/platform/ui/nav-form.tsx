"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useTransition, type FormEvent, type ReactNode } from "react";
import { useReportListPending } from "./list-pending";

/**
 * A GET filter form that navigates client-side (soft nav) instead of doing a
 * full document reload. It renders a normal `method="GET"` form -- so it still
 * works without JS and stays shareable/bookmarkable -- but intercepts submit:
 * it serialises the form's named fields into the querystring and `router.push`es,
 * which keeps the persistent app shell (toolbar/navbar) mounted rather than
 * reloading the whole page. Empty fields are dropped, so an "All ..." option
 * clears its param. Drop-in replacement for `<form method="GET">` filter bars on
 * server pages (mirrors RequestFilters, but as a generic wrapper that keeps the
 * existing markup and submit button). `action` is optional: when omitted it
 * targets the current pathname, matching an action-less GET form that submits
 * to itself.
 */
export function NavForm({
  action,
  children,
  className,
}: {
  action?: string;
  children: ReactNode;
  className?: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const target = action ?? pathname;

  // The push runs inside a transition purely so its pending state is
  // observable: a filter submit is a `?`-only navigation, so loading.tsx never
  // fires and the list would otherwise sit looking current while the server
  // re-queries. Reported up to ListPendingProvider, which PendingDim reads.
  // useFormStatus cannot serve here: it only tracks a form whose `action` is a
  // function, and this form preventDefault()s and pushes.
  const [isNavigating, startNavigation] = useTransition();
  useReportListPending(isNavigating);

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const params = new URLSearchParams();
    for (const [key, value] of new FormData(event.currentTarget).entries()) {
      if (typeof value === "string" && value.trim() !== "") params.set(key, value);
    }
    const qs = params.toString();
    startNavigation(() => router.push(qs ? `${target}?${qs}` : target));
  }

  return (
    <form method="GET" action={action} onSubmit={handleSubmit} className={className}>
      {children}
    </form>
  );
}

/**
 * The same navigation NavForm performs, for a filter that submits on CHANGE
 * rather than on submit.
 *
 * Three filter surfaces navigate by calling `router.push` directly: the support
 * request filters and recruitment's decision and department pickers. A bare
 * push reports nothing, so changing a Status select re-queried the server while
 * the rows sat looking current -- on the same pages where clicking a PAGE
 * dims them, because Pagination reports through the very machinery these
 * skipped.
 *
 * The gap is total rather than partial. A `?`-only navigation never remounts a
 * Suspense boundary, so loading.tsx does not fire; and the top progress bar is
 * driven by @bprogress's anchor-click handler, so a programmatic push starts no
 * bar either. Nothing on screen moved at all.
 *
 * `page` is always dropped: the page number the viewer was on may not exist
 * under the new filter, which is the same reason NavForm rebuilds its query
 * from scratch.
 */
export function useNavFilter(): (mutate: (params: URLSearchParams) => void) => void {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [isNavigating, startNavigation] = useTransition();
  useReportListPending(isNavigating);

  return (mutate) => {
    const href = nextFilterUrl(pathname, searchParams.toString(), mutate);
    startNavigation(() => router.push(href));
  };
}

/**
 * The URL a filter change navigates to. Split out of the hook so it can be
 * tested without a React renderer -- the repo has no @testing-library.
 *
 * Every param the viewer did not touch is preserved: a filter that rebuilt the
 * query from scratch would silently drop the others, which is the same trap
 * FlashReader's strip loop documents.
 */
export function nextFilterUrl(
  pathname: string,
  search: string,
  mutate: (params: URLSearchParams) => void,
): string {
  const params = new URLSearchParams(search);
  mutate(params);
  // The page the viewer was on may not exist under the new filter.
  params.delete("page");
  const qs = params.toString();
  return qs ? `${pathname}?${qs}` : pathname;
}
