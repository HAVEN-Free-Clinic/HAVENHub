/**
 * Paths a not-yet-cleared volunteer may reach: the onboarding flow (`/get-started` and its sub-routes), the SCORM course player under `/learning`, and the auth escape hatches. Prefix-matched, so sub-paths (e.g.
 * /learning/abc) are covered.
 *
 * Pure (no Next or DB imports) so it stays unit-testable and cheap to evaluate
 * on every page render.
 */
export const ONBOARDING_ALLOWLIST = ["/get-started", "/learning", "/login", "/welcome"];

/** True when `path` is the gate, a task fix-it page, or an auth route. */
export function isAllowlistedPath(path: string): boolean {
  return ONBOARDING_ALLOWLIST.some((p) => path === p || path.startsWith(`${p}/`));
}
