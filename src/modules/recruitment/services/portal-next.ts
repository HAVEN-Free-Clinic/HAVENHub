// Shared validation for the post-sign-in `next` redirect target used across the
// applicant portal (magic-link verify route, Yale SSO callbackUrl, sign-in form).
// Only a same-origin, slash-rooted path is allowed so the redirect can never be
// turned into an open redirect (`//evil.com`, `/\evil.com`, `https://evil.com`).
export const PORTAL_HOME = "/apply";

export function safeNextPath(raw: string | null | undefined): string {
  if (!raw || !/^\/[^/\\]/.test(raw)) return PORTAL_HOME;
  // Reject any ASCII control character (0x00-0x1F, 0x7F), notably tab/LF/CR. The
  // WHATWG URL parser strips those before parsing, so an input like `/\t/evil.com`
  // would collapse to `//evil.com` (an external origin) and slip past the
  // same-origin check above.
  for (let i = 0; i < raw.length; i += 1) {
    const code = raw.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return PORTAL_HOME;
  }
  return raw;
}
