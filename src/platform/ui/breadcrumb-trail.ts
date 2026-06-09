import type { ModuleManifest } from "@/platform/modules/types";

/** A single breadcrumb. The current page's crumb omits `href`. */
export type Crumb = { label: string; href?: string };

/** Registry data the breadcrumb needs (serializable, no icon). */
export type BreadcrumbModule = Pick<ModuleManifest, "id" | "title" | "nav">;

/**
 * Build a breadcrumb trail from a pathname and the module registry.
 *
 * Root is always "Hub" (/). On the hub itself the trail is just "Hub" (current).
 * For detail pages the trail ends at the parent section (the escape link) unless
 * `leafLabel` is supplied (option B), in which case it is appended as the
 * current crumb. A trailing `new` segment becomes a "New" crumb.
 */
export function buildBreadcrumbs(
  pathname: string,
  modules: BreadcrumbModule[],
  leafLabel?: string,
): Crumb[] {
  const path = pathname.replace(/\/+$/, "") || "/";
  if (path === "/") return [{ label: "Hub" }];

  const hub: Crumb = { label: "Hub", href: "/" };
  const segments = path.split("/").filter(Boolean);
  const mod = modules.find((m) => m.id === segments[0]);
  if (!mod) return [hub];

  const moduleHref = `/${mod.id}`;
  if (segments.length === 1) {
    // At the module root: module is the current page.
    return [hub, { label: mod.title }];
  }

  const crumbs: Crumb[] = [hub, { label: mod.title, href: moduleHref }];

  // Exact section match -> that section is the current page.
  const section = mod.nav.find((n) => n.href === path);
  if (section) {
    crumbs.push({ label: section.label });
    return crumbs;
  }

  // Deeper than a section (a detail id or "new"): link the parent section.
  const parentSection = mod.nav
    .filter((n) => n.href !== moduleHref && path.startsWith(`${n.href}/`))
    .sort((a, b) => b.href.length - a.href.length)[0];
  if (parentSection) {
    crumbs.push({ label: parentSection.label, href: parentSection.href });
  }

  const last = segments[segments.length - 1];
  if (last === "new") {
    crumbs.push({ label: "New" });
  } else if (leafLabel) {
    crumbs.push({ label: leafLabel });
  }
  // Otherwise (dynamic id, option A): no leaf; the section link is the escape.

  return crumbs;
}
