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
