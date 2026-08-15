/**
 * Pure string helpers for the public application portal's custom subdomain.
 * No next/prisma/config imports so they run in unit tests and in the proxy layer.
 *
 * The portal is served from a dedicated host (PORTAL_BASE_URL) that rewrites onto
 * the existing /apply route tree. These helpers decide what to rewrite, keep the
 * reserved-slug list in sync with the proxy pass-throughs, and build canonical
 * portal links.
 */

/**
 * First path segments the proxy must NOT rewrite onto /apply, which therefore
 * cannot be used as a cycle's public slug (a slug of "api" would produce a public
 * link that collides with a pass-through and 404s for the applicant).
 */
export const RESERVED_PORTAL_SLUGS = [
  "apply",
  "api",
  "login",
  "brand",
  "verify",
  "favicon",
  "_next",
  // Maintenance mode redirects a blocked visitor to /maintenance on whatever
  // host they arrived at, the portal host included. Without this the rewrite
  // would send that redirect to /apply/maintenance and serve a 404 in place of
  // the maintenance page.
  "maintenance",
] as const;

/** Parse the host (with port, if any) from a URL string; null if empty/invalid. */
export function hostFromUrl(url: string | undefined | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

/** True when a portal-host request should be served as-is (not rewritten to /apply). */
export function isPortalPassThrough(pathname: string): boolean {
  // Static files (a dot in the final segment): /brand/x.webp, /favicon.ico, /robots.txt.
  const lastSegment = pathname.split("/").pop() ?? "";
  if (lastSegment.includes(".")) return true;
  const first = pathname.split("/").filter(Boolean)[0];
  if (!first) return false; // "/" is rewritten to the portal home
  return (RESERVED_PORTAL_SLUGS as readonly string[]).includes(first);
}

/** Map a portal-host pathname onto the /apply tree. "/" -> "/apply"; "/x" -> "/apply/x". */
export function rewriteToApply(pathname: string): string {
  return pathname === "/" ? "/apply" : `/apply${pathname}`;
}

/** True when a would-be cycle slug collides with a proxy pass-through word. */
export function isReservedSlug(slug: string): boolean {
  return (RESERVED_PORTAL_SLUGS as readonly string[]).includes(slug.toLowerCase());
}

/**
 * Canonical public application URL. With a portal base set, the pretty form
 * (`${portalBase}/${slug}`) which the proxy rewrites to /apply/<slug>. Without one
 * (pre-launch), the working hub path (`${appBase}/apply/${slug}`).
 */
export function buildPortalUrl(portalBase: string | undefined, appBase: string, slug?: string): string {
  if (portalBase) {
    const base = portalBase.replace(/\/+$/, "");
    return slug ? `${base}/${slug}` : base;
  }
  const base = appBase.replace(/\/+$/, "");
  return slug ? `${base}/apply/${slug}` : `${base}/apply`;
}

/**
 * Choose the base URL for a magic-link email. Returns the portal base ONLY when
 * the request host equals the portal host, else the app base. The host is used
 * for an equality check against a known value, never interpolated into the URL,
 * so a spoofed Host cannot redirect the emailed link. Both return values are
 * trusted, configured deploy values.
 */
export function pickPortalEmailBase(
  requestHost: string | null,
  portalBase: string | undefined,
  appBase: string,
): string {
  const base = portalBase && requestHost && hostFromUrl(portalBase) === requestHost ? portalBase : appBase;
  return base.replace(/\/+$/, "");
}
