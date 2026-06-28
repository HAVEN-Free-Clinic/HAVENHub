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
import type { Person, Prisma } from "@prisma/client";
import { prisma } from "@/platform/db";
import { recordAudit } from "@/platform/audit";
import { PersonNotFoundError } from "@/platform/people";

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

/** The clinic-wide review queue rows, name-ordered, for the Phase 2 surface. */
export async function listSpanishReviewQueue(): Promise<
  Array<{ id: string; name: string; netId: string | null; contactEmail: string | null }>
> {
  return prisma.person.findMany({
    where: spanishReviewWhere(),
    orderBy: { name: "asc" },
    select: { id: true, name: true, netId: true, contactEmail: true },
  });
}

/**
 * Record an interpreting-department Spanish assessment. Always stamps the
 * verifier + timestamp (a "no" is still an assessment), so the person leaves
 * the queue either way. Distinct from updatePersonFields' admin override.
 */
export async function recordSpanishAssessment(
  actorPersonId: string,
  personId: string,
  verified: boolean,
): Promise<Person> {
  const existing = await prisma.person.findUnique({ where: { id: personId } });
  if (!existing) throw new PersonNotFoundError(personId);

  const updated = await prisma.person.update({
    where: { id: personId },
    data: {
      spanishVerified: verified,
      spanishVerifiedAt: new Date(),
      spanishVerifiedById: actorPersonId,
    },
  });

  await recordAudit({
    actorPersonId,
    action: "person.spanish_assess",
    entityType: "Person",
    entityId: personId,
    before: {
      spanishVerified: existing.spanishVerified,
      spanishVerifiedAt: existing.spanishVerifiedAt?.toISOString() ?? null,
    },
    after: {
      spanishVerified: updated.spanishVerified,
      spanishVerifiedAt: updated.spanishVerifiedAt?.toISOString() ?? null,
    },
  });

  return updated;
}
