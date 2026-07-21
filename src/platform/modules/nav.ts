/**
 * Client-safe module-nav helpers.
 *
 * Deliberately imports nothing from the RBAC engine or Prisma, so a "use client"
 * component (the global nav) can use these without relying on the bundler to
 * tree-shake PrismaClient out of the client bundle. The permission-gated, DB-backed
 * helpers (canAccessModule, filterNavItems, getAccessibleModules) stay in ./access,
 * which is only imported by server components.
 */

/** A module reduced to what the global nav needs (serializable, no icon). */
export type NavModule = { id: string; title: string; href: string };

/**
 * Active-state test for a module link given the current pathname.
 * Intentionally differs from ModuleNav's active logic: module links stay highlighted
 * across the whole module subtree (always prefix-match), whereas ModuleNav avoids
 * prefix-matching the module-root tab to prevent every sub-page from highlighting it.
 */
export function isModuleActive(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}
