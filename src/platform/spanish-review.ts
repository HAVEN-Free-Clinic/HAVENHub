/**
 * Interpreting-department Spanish review queue.
 *
 * A person needs interpreting-department review when they have never been
 * through a human assessment (spanishVerifiedAt is null) but carry a Spanish
 * signal (self-reported, or a provisional verified flag). `spanishVerifiedAt`
 * is the single source of truth for "assessed by a human": once it is set
 * (yes OR no), the person leaves the queue.
 *
 * Phase 1 ships this predicate so Phase 2 (the interpreting-department surface)
 * only has to add UI on top of it.
 */
import type { Prisma } from "@prisma/client";

export function needsSpanishReview(p: {
  spanishSelfReported: boolean;
  spanishVerified: boolean;
  spanishVerifiedAt: Date | null;
}): boolean {
  return p.spanishVerifiedAt === null && (p.spanishSelfReported || p.spanishVerified);
}

export function spanishReviewWhere(): Prisma.PersonWhereInput {
  return {
    spanishVerifiedAt: null,
    OR: [{ spanishSelfReported: true }, { spanishVerified: true }],
  };
}
