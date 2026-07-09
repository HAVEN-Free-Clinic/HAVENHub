import { NextResponse, type NextRequest } from "next/server";
import { hostFromUrl, isPortalPassThrough, rewriteToApply } from "@/modules/recruitment/services/portal-routing";

/**
 * Per-request proxy (Next 16 renamed `middleware` to `proxy`; Node runtime).
 *
 * 1. Stamps the incoming pathname into a header so server components (the
 *    onboarding gate in requirePersonSession) can read the current path.
 * 2. On the application-portal host (PORTAL_BASE_URL), rewrites clean portal
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

export function proxy(request: NextRequest): NextResponse {
  return resolveProxy(request, hostFromUrl(process.env.PORTAL_BASE_URL));
}

export const config = {
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico).*)"],
};
