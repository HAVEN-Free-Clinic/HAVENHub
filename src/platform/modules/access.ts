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
 * access only); an item with one is shown only when the viewer holds it. Keeps
 * the ModuleNav consistent with the per-page gate so no tab is a dead end.
 */
export function filterNavItems(
  items: ModuleNavItem[],
  perms: Set<string>,
): ModuleNavItem[] {
  return items.filter((item) => !item.permission || hasPermission(perms, item.permission));
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
 */
export function filterAccessibleModules(
  modules: ModuleManifest[],
  perms: Set<string>,
  extraIds: ReadonlySet<string> = new Set(),
  extraNavItems: Readonly<Record<string, NavSubItem[]>> = {},
): NavModule[] {
  return modules
    .filter((m) => m.status === "active" && (canAccessModule(m, perms) || extraIds.has(m.id)))
    .map((m) => ({
      id: m.id,
      title: m.title,
      href: `/${m.id}`,
      nav: [
        // Strip `permission`: it has already been applied, and the consumer is a
        // client component.
        ...filterNavItems(m.nav, perms).map(({ label, href }) => ({ label, href })),
        ...(extraNavItems[m.id] ?? []),
      ],
    }));
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
