"use client";

import { useEffect, useRef } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { classifyFlashParams } from "./flash";
import { useToast } from "./toast";
// One sanctioned platform -> module import, the same shape as the onboarding
// gate's exception in auth/session.ts. The applicant portal host
// (apply.havenfreeclinic.org) rewrites its clean URLs onto /apply/* entirely
// server-side (src/proxy.ts), so usePathname() can never see that rewrite --
// it always reports the PRE-rewrite path on that host ("/", "/some-slug").
// Resolving classifyFlashParams's pathname correctly there requires the exact
// mapping the proxy itself uses, which is owned by the recruitment module
// (the portal is a recruitment concern, public application intake). See
// flash.ts's module doc comment, "applicant portal host" section, for why
// this is a required caller-side fix rather than something the classifier
// itself can absorb.
// eslint-disable-next-line no-restricted-imports, import/no-restricted-paths
import { isPortalPassThrough, rewriteToApply } from "@/modules/recruitment/services/portal-routing";

/**
 * Undoes the applicant-portal host's pathname rewrite so `classifyFlashParams`
 * sees the EFFECTIVE route (e.g. "/apply", "/apply/some-slug") that its
 * `/apply`-scoped registry and code-table entries are written against, not
 * the raw pre-rewrite path `usePathname()` reports on that host (e.g. "/",
 * "/some-slug"). `isPortalHost` is resolved server-side, in the root layout,
 * by comparing the request's Host header against `config.PORTAL_BASE_URL`
 * the same way `src/proxy.ts` does: `config.ts` validates server secrets and
 * must never be imported into this client component's bundle, so the layout
 * threads down only the one boolean this reader actually needs.
 */
function resolveEffectivePathname(rawPathname: string, isPortalHost: boolean): string {
  if (!isPortalHost || isPortalPassThrough(rawPathname)) return rawPathname;
  return rewriteToApply(rawPathname);
}

/**
 * Reads the URL's flash-classified search params, pops one toast per claimed
 * group, then strips exactly those param names, leaving every other param
 * untouched. Mounted once in the root layout (`src/app/layout.tsx`), inside
 * `ToastProvider`, beside `InactivityTracker` -- see that file for why it has
 * to be the root layout and not `AppShell`.
 *
 * No `Suspense` boundary around `useSearchParams()` here, unlike the usual
 * App Router advice: that guard exists to stop a page opting into static
 * generation from being forced to client-side render around the hook (Next's
 * "missing-suspense-with-csr-bailout"). This app's root layout already calls
 * `cookies()`/`headers()`/`auth()` unconditionally, so the whole tree is
 * dynamic on every request regardless -- there is no static path to bail out
 * of. A `<Suspense fallback={null}>` was tried and produced a real hydration
 * mismatch instead (the CSR-bailout boundary's SSR "reveal" marker landing
 * where `ToastViewport`'s portalled div hydrates), which is worse than the
 * warning it would have silenced.
 */
export function FlashReader({ isPortalHost }: { isPortalHost: boolean }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const searchString = searchParams.toString();
  const router = useRouter();
  const toast = useToast();

  // Guards against processing the same query string twice: React StrictMode's
  // double effect invocation in dev, and any re-render whose dependencies
  // happen to be unchanged (pushing a toast re-renders this component, since
  // it shares ToastProvider's context). A genuinely new redirect lands with a
  // different search string and updates this ref. A browser refresh is
  // guarded separately, by the strip below: it removes the claimed params
  // from the URL, so a refreshed page loads with nothing left to reprocess.
  const processedRef = useRef<string | null>(null);

  useEffect(() => {
    if (processedRef.current === searchString) return;
    processedRef.current = searchString;

    const effectivePathname = resolveEffectivePathname(pathname, isPortalHost);
    const { toasts, stripParams } = classifyFlashParams(searchParams, effectivePathname);
    if (toasts.length === 0) return;

    for (const t of toasts) toast(t);

    // Strip exactly the claimed params, preserving every other one on the URL
    // untouched (filters, tokens, view modes, ...). Rebuilding the query from
    // only the recognised names, instead of deleting from a copy of the full
    // set, would silently drop every filter a page relies on.
    const remaining = new URLSearchParams(searchString);
    for (const name of stripParams) remaining.delete(name);
    const query = remaining.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  }, [searchString, pathname, isPortalHost, router, toast, searchParams]);

  return null;
}
