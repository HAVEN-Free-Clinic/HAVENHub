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
type LeafOverride = { path: string; leaf: string };
type BreadcrumbCtx = {
  override: Override | null;
  setOverride: (o: Override | null) => void;
  leaf: LeafOverride | null;
  setLeaf: (l: LeafOverride | null) => void;
};

const Ctx = createContext<BreadcrumbCtx | null>(null);

export function BreadcrumbProvider({ children }: { children: ReactNode }) {
  const [override, setOverride] = useState<Override | null>(null);
  const [leaf, setLeaf] = useState<LeafOverride | null>(null);
  // Memoise the context value so its identity only changes when the state does.
  // The useState setters are already referentially stable. Passing a fresh
  // object literal here would re-render every consumer on each provider render.
  const value = useMemo(
    () => ({ override, setOverride, leaf, setLeaf }),
    [override, leaf],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** Read the active override trail, but only if it targets `currentPath`. */
export function useBreadcrumbOverride(currentPath: string): Crumb[] | null {
  const ctx = useContext(Ctx);
  if (!ctx?.override) return null;
  return ctx.override.path === currentPath ? ctx.override.trail : null;
}

/** Read the active leaf label, but only if it targets `currentPath`. */
export function useBreadcrumbLeaf(currentPath: string): string | null {
  const ctx = useContext(Ctx);
  if (!ctx?.leaf) return null;
  return ctx.leaf.path === currentPath ? ctx.leaf.leaf : null;
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

/**
 * Names the record a detail page is showing, and renders nothing.
 *
 * Eighteen detail routes ended their breadcrumb on the parent section, so
 * "Hub > Admin > People" was the whole trail whether you were looking at one
 * person or another. The bar could not name the record because the record is
 * loaded by the page, which renders BELOW the AppShell that draws the bar.
 *
 * ## Why a leaf, not a trail
 *
 * Recruitment supplies a whole trail through `SetBreadcrumb`, and has to:
 * every real recruitment page hangs off `/recruitment/cycles/[id]/…`, a
 * hierarchy the module registry cannot describe, and the cycle crumb is
 * role-aware. Nothing else has that problem. For the other eighteen routes the
 * registry already produces `Hub > Module > Section` correctly, with the
 * section linked as the way out; the ONE thing it cannot know is the record's
 * name.
 *
 * So these pages supply exactly that, and `buildBreadcrumbs` appends it, which
 * is the `leafLabel` argument it has always taken. The alternative the audit
 * proposed -- a trail helper per module, each page composing Hub + module +
 * section + leaf by hand -- would restate on eighteen pages what the registry
 * already knows, and go stale the moment a section moves.
 */
export function SetBreadcrumbLeaf({ label }: { label: string }) {
  // Same reasoning as SetBreadcrumb: depend on the stable setter, not on the
  // context value object, which is recreated whenever this effect sets state.
  const setLeaf = useContext(Ctx)?.setLeaf;
  const path = usePathname();
  useEffect(() => {
    setLeaf?.({ path, leaf: label });
  }, [setLeaf, path, label]);
  return null;
}
