/**
 * Pure path rules for maintenance mode. No next/prisma/config imports, so the
 * proxy layer, the page, and unit tests all share one definition of what stays
 * reachable while the hub is down.
 *
 * The identity half of the gate (is this person a Platform Admin?) lives in
 * request-gate.ts, which needs the request; this file answers only "is this
 * path exempt regardless of who is asking?".
 */

/**
 * Path prefixes that stay reachable while maintenance mode is on, matched a
 * whole segment at a time so "/loginfoo" is not mistaken for "/login".
 *
 *  - /maintenance  the page itself, or the redirect loops.
 *  - /login        the way back in. Anyone may reach it and sign in; only a
 *                  Platform Admin gets further than /maintenance afterwards.
 *  - /credential   public volunteer-passport pages. Read-only, session-less,
 *                  and shared outside the clinic, so a maintenance window on
 *                  the hub should not break a link on someone's CV.
 *  - /api          cron delivery, the calendar feed, health checks, and the
 *                  NextAuth callbacks. Listed for the record and for safety:
 *                  the proxy matcher in proxy.ts already excludes /api, so
 *                  these never reach this check unless that matcher changes.
 *  - /ingest       the PostHog reverse proxy (a next.config rewrite straight
 *                  out to posthog.com). It holds none of our data and reaches
 *                  none of our database, so blocking it buys nothing and costs
 *                  the analytics for the two pages that stay up: every beacon
 *                  from /login and /maintenance would get a 307 to an HTML
 *                  page and log a JSON parse error in the visitor's console.
 */
export const MAINTENANCE_EXEMPT_PREFIXES = [
  "/maintenance",
  "/login",
  "/credential",
  "/api",
  "/ingest",
] as const;

/** True when `pathname` must be served normally even with maintenance mode on. */
export function isMaintenanceExempt(pathname: string): boolean {
  // Static files (a dot in the final segment): /brand/x.webp, /favicon.ico,
  // /robots.txt. Same heuristic isPortalPassThrough already uses, kept
  // deliberately identical so the two lists cannot drift.
  const lastSegment = pathname.split("/").pop() ?? "";
  if (lastSegment.includes(".")) return true;
  if (pathname === "/_next" || pathname.startsWith("/_next/")) return true;
  return MAINTENANCE_EXEMPT_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`)
  );
}
