"use client";

import { usePathname, useRouter } from "next/navigation";
import type { FormEvent, ReactNode } from "react";

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

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const params = new URLSearchParams();
    for (const [key, value] of new FormData(event.currentTarget).entries()) {
      if (typeof value === "string" && value.trim() !== "") params.set(key, value);
    }
    const qs = params.toString();
    router.push(qs ? `${target}?${qs}` : target);
  }

  return (
    <form method="GET" action={action} onSubmit={handleSubmit} className={className}>
      {children}
    </form>
  );
}
