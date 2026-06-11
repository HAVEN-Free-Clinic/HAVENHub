import { NextResponse, type NextRequest } from "next/server";

/**
 * Stamp the incoming pathname into a request header so server components
 * (notably requirePersonSession's onboarding gate) can read the current path.
 * Page routes only; API, Next internals, and static assets are excluded by the
 * matcher below, so this never runs on data/asset requests.
 *
 * Next 16 renamed `middleware` to `proxy` (Node runtime, no edge). Lives in
 * `src/` because this project keeps its app under `src/app`.
 */
export function proxy(request: NextRequest) {
  const headers = new Headers(request.headers);
  headers.set("x-pathname", request.nextUrl.pathname);
  return NextResponse.next({ request: { headers } });
}

export const config = {
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico).*)"],
};
