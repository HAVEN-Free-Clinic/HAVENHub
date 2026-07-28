/**
 * Paths a not-yet-cleared volunteer may reach: the onboarding flow
 * (`/get-started` and its sub-routes) and the auth escape hatches.
 * Prefix-matched, so sub-paths (e.g. /get-started/learning/abc) are covered.
 *
 * `/learning` is deliberately NOT here. It lives in the (app) route group, so
 * admitting an uncleared member to it rendered the whole AppShell toolbar and
 * module nav around the course player: every tab looked live, and clicking one
 * re-ran the gate and ejected them back to /get-started. The onboarding course
 * player is `/get-started/learning/[courseId]` instead, covered by the prefix
 * above. The SCORM content route and the persist-cmi beacon authenticate with
 * auth() directly, never requirePersonSession, so they are unaffected by this
 * list.
 *
 * Pure (no Next or DB imports) so it stays unit-testable and cheap to evaluate
 * on every page render.
 */
export const ONBOARDING_ALLOWLIST = ["/get-started", "/login", "/welcome"];

/** True when `path` is the gate, a task fix-it page, or an auth route. */
export function isAllowlistedPath(path: string): boolean {
  return ONBOARDING_ALLOWLIST.some((p) => path === p || path.startsWith(`${p}/`));
}
