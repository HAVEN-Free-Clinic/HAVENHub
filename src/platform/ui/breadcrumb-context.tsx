"use client";

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import type { Crumb } from "./breadcrumb-trail";

/**
 * Lets a page (rendered below AppShell) supply a rich breadcrumb trail to the
 * global breadcrumb bar (rendered by AppShell, above it). Data can't flow up
 * the tree as props, so a page registers its trail through this context.
 *
 * The override is keyed by pathname: the bar only honours it when the override
 * targets the current route, so a trail left behind by an unmounting page is
 * ignored the moment navigation changes the path.
 */

type Override = { path: string; trail: Crumb[] };
type BreadcrumbCtx = { override: Override | null; setOverride: (o: Override | null) => void };

const Ctx = createContext<BreadcrumbCtx | null>(null);

export function BreadcrumbProvider({ children }: { children: ReactNode }) {
  const [override, setOverride] = useState<Override | null>(null);
  // Memoise the context value so its identity only changes when `override` does.
  // `setOverride` from useState is already referentially stable. Passing a fresh
  // object literal here would re-render every consumer on each provider render.
  const value = useMemo(() => ({ override, setOverride }), [override]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** Read the active override trail, but only if it targets `currentPath`. */
export function useBreadcrumbOverride(currentPath: string): Crumb[] | null {
  const ctx = useContext(Ctx);
  if (!ctx?.override) return null;
  return ctx.override.path === currentPath ? ctx.override.trail : null;
}

/**
 * Registers a breadcrumb trail for the current route, then renders nothing.
 * Rendered by a server-component page with a serializable `trail`; the trail
 * is applied after hydration (first paint shows the route-derived fallback).
 */
export function SetBreadcrumb({ trail }: { trail: Crumb[] }) {
  // Depend on the stable `setOverride` setter, NOT the whole context value.
  // The provider value object is recreated whenever `override` changes, so
  // depending on `ctx` here would re-run the effect every time it sets the
  // override, which causes an infinite setState-in-effect loop ("Maximum update depth").
  const setOverride = useContext(Ctx)?.setOverride;
  const path = usePathname();
  // Serialize so the effect re-runs when the trail contents change.
  const key = JSON.stringify(trail);
  useEffect(() => {
    setOverride?.({ path, trail });
    // `key` stands in for `trail` (a fresh array each render) in the deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setOverride, path, key]);
  return null;
}
