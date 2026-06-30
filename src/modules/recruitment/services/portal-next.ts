// Shared validation for the post-sign-in `next` redirect target used across the
// applicant portal (magic-link verify route, Yale SSO callbackUrl, sign-in form).
// Only a same-origin, slash-rooted path is allowed so the redirect can never be
// turned into an open redirect (`//evil.com`, `/\evil.com`, `https://evil.com`).
export const PORTAL_HOME = "/apply";

export function safeNextPath(raw: string | null | undefined): string {
  if (raw && /^\/[^/\\]/.test(raw)) return raw;
  return PORTAL_HOME;
}
