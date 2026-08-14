import { getEffectivePermissions, hasPermission } from "@/platform/rbac/engine";
import { MODULES } from "./registry";
import type { ModuleManifest, ModuleNavItem } from "./types";
// NavModule + isModuleActive live in the client-safe ./nav module (no engine/prisma
// import) so the "use client" global nav can use them without tree-shaking PrismaClient.
import type { NavModule, NavSubItem } from "./nav";
export type { NavModule, NavSubItem };

/** True when the user may use this module (no permission required, or held). */
export function canAccessModule(
  mod: Pick<ModuleManifest, "accessPermission" | "additionalAccessPermissions">,
  perms: Set<string>,
): boolean {
  return (
    !mod.accessPermission ||
    hasPermission(perms, mod.accessPermission) ||
    (mod.additionalAccessPermissions?.some((p) => hasPermission(perms, p)) ?? false)
  );
}

/**
 * The module sub-tabs the user may actually open. Mirrors canAccessModule at the
 * tab level: an item with no `permission` is always shown (it gates on module
 * access only); an item with one is shown only when the viewer holds it; an item
 * with several is shown when the viewer holds ANY of them, mirroring a page that
 * gates on requireAnyPermission. Keeps the ModuleNav consistent with the per-page
 * gate so no tab is a dead end.
 */
export function filterNavItems(
  items: ModuleNavItem[],
  perms: Set<string>,
): ModuleNavItem[] {
  return items.filter((item) => {
    if (!item.permission) return true;
    const required = Array.isArray(item.permission) ? item.permission : [item.permission];
    return required.some((p) => hasPermission(perms, p));
  });
}

/**
 * Where a module's own top-level link should point.
 *
 * Normally the module root. But a module admitted ONLY via `extraIds` was let in
 * by an out-of-band capability the permission engine cannot see, and its root may
 * be a page that capability does not open: a bare interview panelist reaches
 * recruitment through panel membership, yet /recruitment itself is staff-only and
 * bounces them to /no-access. Land such a viewer on a sub-page instead.
 *
 * `extras` is preferred over `registryNav` when present because the caller
 * resolved it from the very capability that admitted the module, so the caller
 * has already vouched that the viewer can open it. Otherwise fall back to the
 * first permission-filtered registry item, which is what the out-of-band
 * capability unlocks when the caller supplied no extras (a recruitment scope
 * reviewer: no extras, first item "Cycles" -> /recruitment, i.e. unchanged).
 * `registryNav` is passed in purely for this fallback: filterAccessibleModules
 * no longer folds it into such a viewer's `nav` array (see below), but the
 * href still needs somewhere sensible to land when there are no extras either.
 */
function moduleHref(
  id: string,
  admittedOnlyByExtraIds: boolean,
  registryNav: NavSubItem[],
  extras: NavSubItem[],
): string {
  if (!admittedOnlyByExtraIds) return `/${id}`;
  return extras[0]?.href ?? registryNav[0]?.href ?? `/${id}`;
}

/**
 * Active modules the user can access, as nav items with their permission-filtered
 * sub-pages.
 *
 * `extraIds` admits modules whose access can't be expressed as a permission the
 * engine holds -- notably recruitment, which a department director reaches by
 * *review scope* (a derived directorship, not a permission). `extraNavItems`
 * does the same at the sub-item level for tabs gated on dynamic conditions
 * rather than permissions (notably recruitment's "My interviews", gated on
 * interview-panel membership). Both are resolved by the caller (see the (app)
 * layout) so this platform helper stays free of any module-service import.
 *
 * `dynamicGate` items are dropped here and only here: the global nav cannot
 * evaluate a data-driven gate, so offering the link would risk a bounce to
 * /no-access. `filterNavItems` deliberately keeps them, because the module's own
 * layout (which CAN evaluate the gate) filters the ModuleNav tab row on top of it.
 */
export function filterAccessibleModules(
  modules: ModuleManifest[],
  perms: Set<string>,
  extraIds: ReadonlySet<string> = new Set(),
  extraNavItems: Readonly<Record<string, NavSubItem[]>> = {},
): NavModule[] {
  return modules
    .filter((m) => m.status === "active" && !m.personal && (canAccessModule(m, perms) || extraIds.has(m.id)))
    .map((m) => {
      // Strip everything but label/href from BOTH sources: permission strings
      // have already been applied server-side, and the consumer is a client
      // component that must not carry the RBAC vocabulary.
      const registryNav: NavSubItem[] = filterNavItems(m.nav, perms)
        .filter((item) => !item.dynamicGate)
        .map(({ label, href }) => ({ label, href }));
      const extras: NavSubItem[] = (extraNavItems[m.id] ?? []).map(({ label, href }) => ({ label, href }));
      const admittedOnlyByExtraIds = !canAccessModule(m, perms) && extraIds.has(m.id);
      // The registry nav is written for viewers who hold the module's own
      // permission, and its items can carry data-driven gates the platform
      // layer cannot evaluate (dynamicGate, filtered above, is one; a nav item
      // with no `permission` at all -- kept by filterNavItems for everyone --
      // is another, e.g. recruitment's "Cycles" -> /recruitment). A viewer
      // admitted only via extraIds was let in by an out-of-band capability the
      // registry knows nothing about, so registryNav's survivors are not
      // necessarily reachable by them. The caller that supplied extraNavItems
      // is the only party that knows which destinations this viewer can
      // actually open, so for such a viewer its list is authoritative and the
      // registry nav is dropped entirely, not merged in.
      const nav = admittedOnlyByExtraIds ? extras : [...registryNav, ...extras];
      return {
        id: m.id,
        title: m.title,
        href: moduleHref(m.id, admittedOnlyByExtraIds, registryNav, extras),
        nav,
      };
    });
}

/** Server entry point: resolve the signed-in user's accessible modules. */
export async function getAccessibleModules(
  personId: string,
  extraIds: ReadonlySet<string> = new Set(),
  extraNavItems: Readonly<Record<string, NavSubItem[]>> = {},
): Promise<NavModule[]> {
  const perms = await getEffectivePermissions(personId);
  return filterAccessibleModules(MODULES, perms, extraIds, extraNavItems);
}
