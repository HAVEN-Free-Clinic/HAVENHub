import { getEffectivePermissions, hasPermission } from "@/platform/rbac/engine";
import { MODULES } from "./registry";
import type { ModuleManifest } from "./types";

/** A module reduced to what the global nav needs (serializable, no icon). */
export type NavModule = { id: string; title: string; href: string };

/** True when the user may use this module (no permission required, or held). */
export function canAccessModule(
  mod: Pick<ModuleManifest, "accessPermission">,
  perms: Set<string>,
): boolean {
  return !mod.accessPermission || hasPermission(perms, mod.accessPermission);
}

/** Active modules the user can access, as nav items. Excludes coming-soon. */
export function filterAccessibleModules(
  modules: ModuleManifest[],
  perms: Set<string>,
): NavModule[] {
  return modules
    .filter((m) => m.status === "active" && canAccessModule(m, perms))
    .map((m) => ({ id: m.id, title: m.title, href: `/${m.id}` }));
}

/**
 * Active-state test for a module link given the current pathname.
 * Intentionally differs from ModuleNav's active logic: module links stay highlighted across
 * the whole module subtree (always prefix-match), whereas ModuleNav avoids prefix-matching
 * the module-root tab to prevent every sub-page from highlighting the root tab.
 */
export function isModuleActive(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

/** Server entry point: resolve the signed-in user's accessible modules. */
export async function getAccessibleModules(personId: string): Promise<NavModule[]> {
  const perms = await getEffectivePermissions(personId);
  return filterAccessibleModules(MODULES, perms);
}
