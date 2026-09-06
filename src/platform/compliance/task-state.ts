/**
 * Onboarding task identity and resolution.
 *
 * These two types live in platform, not in the onboarding engine that derives
 * them, because both modules and platform need to name them: `my-info` renders
 * a member's clearance, `volunteers` renders a director's roster, and
 * `platform/email` writes the weekly digest. A module may not import another
 * module (eslint.config.mjs), so the shared vocabulary has to sit here or every
 * consumer redeclares it. Two already had.
 *
 * The engine at modules/onboarding/engine/status.ts re-exports both, so callers
 * that already import them from there keep working.
 */

/** The onboarding requirements a member clears for the active term. */
export type OnboardingTaskKey =
  | "profile"
  | "hipaa"
  | "training"
  | "directorTraining"
  | "learning"
  | "ehs";

/**
 * Per-task resolution. NOT_REQUIRED means the task does not apply (e.g. no
 * courses assigned) and is treated as satisfied for gating.
 */
export type OnboardingTaskState =
  | "COMPLETE"
  | "IN_PROGRESS"
  | "INCOMPLETE"
  | "NOT_REQUIRED";
