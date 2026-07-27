import { config } from "@/platform/config";

/**
 * A same-origin, slash-rooted destination or the "/" default. Parsing against
 * APP_BASE_URL with the WHATWG URL API rejects absolute URLs and the
 * protocol-relative / backslash tricks ("//evil.com", "/\evil.com") a naive
 * string check misses. Shared by the login page, the member login-link email,
 * and the member verify page so the redirect can never become an open redirect.
 */
export function safeLoginPath(raw: string | null | undefined): string {
  if (!raw) return "/";
  try {
    const base = new URL(config.APP_BASE_URL);
    const target = new URL(raw, base);
    if (target.origin === base.origin && /^\/[^/\\]/.test(target.pathname)) {
      return target.pathname + target.search;
    }
  } catch {
    // Malformed input: fall through to the default.
  }
  return "/";
}

/**
 * The /login URL to bounce a signed-out visitor to, carrying where they were
 * headed so sign-in resumes there instead of dumping them on the dashboard.
 * Every emailed deep link (review queue, compliance master view, shift
 * reminders) depends on this.
 *
 * The destination is run through safeLoginPath first, so a hostile or malformed
 * path degrades to a bare /login rather than being echoed into the query string.
 * "/" and a missing path both yield a bare /login: there is nothing to resume.
 *
 * Note: proxy.ts stamps only `nextUrl.pathname` into x-pathname, so any query
 * string on the original request is not preserved through this callback.
 */
export function loginRedirectPath(pathname: string | null | undefined): string {
  const target = safeLoginPath(pathname);
  if (target === "/") return "/login";
  return `/login?callbackUrl=${encodeURIComponent(target)}`;
}
