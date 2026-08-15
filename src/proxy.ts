import { NextResponse, type NextRequest } from "next/server";
import { hostFromUrl, isPortalPassThrough, rewriteToApply } from "@/modules/recruitment/services/portal-routing";
import { isBlockedByMaintenance } from "@/platform/maintenance/request-gate";

/**
 * Per-request proxy (Next 16 renamed `middleware` to `proxy`; Node runtime).
 *
 * 1. Sends everyone except a Platform Admin to /maintenance while maintenance
 *    mode is on. This is the only layer that sees signed-out visitors, the
 *    portal host, and server-action POSTs alike, which is why the switch lives
 *    here rather than in a layout.
 * 2. Stamps the incoming pathname into a header so server components (the
 *    onboarding gate in requirePersonSession) can read the current path.
 * 3. On the application-portal host (PORTAL_BASE_URL), rewrites clean portal
 *    URLs onto the existing /apply route tree, so apply.havenfreeclinic.org/<slug>
 *    serves /apply/<slug> without exposing the prefix. Auth, api, existing
 *    /apply/* paths, and static assets pass through untouched.
 *
 * The matcher below already excludes api/_next/image/favicon at the data/asset
 * layer; the pass-through check guards the remaining routes on the portal host.
 */
export function resolveProxy(request: NextRequest, portalHost: string | null): NextResponse {
  const headers = new Headers(request.headers);
  headers.set("x-pathname", request.nextUrl.pathname);

  const host = request.headers.get("host");
  if (portalHost && host === portalHost && !isPortalPassThrough(request.nextUrl.pathname)) {
    const url = request.nextUrl.clone();
    url.pathname = rewriteToApply(request.nextUrl.pathname);
    return NextResponse.rewrite(url, { request: { headers } });
  }

  return NextResponse.next({ request: { headers } });
}

/**
 * Where a blocked request goes. A redirect rather than a rewrite: App Router
 * pages cannot set a status code, so a rewrite would serve the maintenance page
 * as a 200 under the original URL and leave the visitor unsure whether their
 * link was broken. "maintenance" is a reserved portal slug, so this resolves to
 * the page on the portal host too instead of rewriting onto /apply/maintenance.
 */
export function maintenanceRedirect(request: NextRequest): NextResponse {
  return NextResponse.redirect(new URL("/maintenance", request.nextUrl.origin));
}

export async function proxy(request: NextRequest): Promise<NextResponse> {
  if (await isBlockedByMaintenance(request)) return maintenanceRedirect(request);
  return resolveProxy(request, hostFromUrl(process.env.PORTAL_BASE_URL));
}

export const config = {
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico).*)"],
};
