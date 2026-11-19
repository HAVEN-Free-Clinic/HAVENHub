/**
 * The recruitment module's authorization and acceptance errors. They live in
 * their own module, rather than in review.ts where they started, so that
 * review-lock.ts can subclass RecruitmentAuthError while review.ts imports the
 * lock: a class in a circular import is read before it is defined. review.ts
 * re-exports both, so existing imports are unchanged.
 */
export class RecruitmentAuthError extends Error {
  constructor(message: string) { super(message); this.name = "RecruitmentAuthError"; }
}
export class AcceptanceError extends Error {
  constructor(message: string) { super(message); this.name = "AcceptanceError"; }
}
