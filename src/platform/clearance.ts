/**
 * Platform facade for the onboarding clearance aggregator.
 *
 * loadClearanceMap computes full clearance (profile, HIPAA, training, learning, EHS)
 * by reusing the onboarding engine, which is owned by the onboarding module. Modules
 * (volunteers, schedule, email) must not import each other, so they consume clearance
 * through this platform facade. This mirrors the sanctioned platform->module import of
 * getOnboardingStatus in src/platform/auth/session.ts.
 */
// eslint-disable-next-line no-restricted-imports, import/no-restricted-paths
export { loadClearanceMap, type ClearanceSummary, type ClearanceTask } from "@/modules/onboarding/services/clearance";
