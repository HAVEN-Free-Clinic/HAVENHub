/**
 * Whether a returning applicant is a CONTINUOUS renewal, or is coming back after
 * sitting a term (or several) out.
 *
 * The apply portal calls anyone with an ACTIVE membership in any past term a
 * returning applicant, and it is right to: their record, their departments and
 * their locked identity all still apply. But "returning" flattens two quite
 * different people. One worked last Saturday. The other last worked eighteen
 * months ago, has not met the current directors, and has almost certainly let
 * their HIPAA certificate and their training lapse. A reviewer reading
 * "Renewal" has no way to tell them apart, and the second is a decision worth
 * making deliberately.
 *
 * So this reports the fact rather than a judgment: the last term they served,
 * and the terms that ran in between which they were not on the roster for. It
 * gates nothing, filters nothing, and hides nothing.
 *
 * A term "ran" if it has at least one ACTIVE membership. That test, rather than
 * simply counting every Term row between the two dates, is what stops a summer
 * the clinic never staffed, or a term someone created and abandoned in Admin,
 * from reading as a break in service the applicant chose to take.
 */

import { prisma } from "@/platform/db";

export type ServiceGap = {
  /** The most recent term they served before the one being recruited for. */
  lastTerm: { code: string; name: string };
  /**
   * Terms that ran between that one and the cycle's, in calendar order, which
   * they were not on the roster for. Empty means a continuous renewal.
   */
  missedTerms: { code: string; name: string }[];
};

/**
 * Service gaps for a set of people, against the term a cycle recruits for.
 *
 * Batched because the applicant roster asks for the whole page at once; the
 * single-person form below delegates to it. People with no prior membership at
 * all are simply absent from the map -- there is no gap to report about someone
 * who has never served.
 */
export async function serviceGapsForCycle(
  personIds: string[],
  cycleTermId: string,
): Promise<Map<string, ServiceGap>> {
  const out = new Map<string, ServiceGap>();
  const unique = [...new Set(personIds.filter(Boolean))];
  if (unique.length === 0) return out;

  const cycleTerm = await prisma.term.findUnique({
    where: { id: cycleTermId },
    select: { startDate: true },
  });
  if (!cycleTerm) return out;

  // Every past term each person served in. Bounded by the cycle's own term so a
  // membership in the term being recruited for (a mid-term cycle, or a record
  // already promoted) does not read as "they are already continuous".
  const memberships = await prisma.termMembership.findMany({
    where: {
      personId: { in: unique },
      status: "ACTIVE",
      term: { startDate: { lt: cycleTerm.startDate } },
    },
    select: {
      personId: true,
      term: { select: { code: true, name: true, startDate: true } },
    },
  });
  if (memberships.length === 0) return out;

  const lastByPerson = new Map<string, { code: string; name: string; startDate: Date }>();
  for (const m of memberships) {
    const current = lastByPerson.get(m.personId);
    if (!current || m.term.startDate > current.startDate) lastByPerson.set(m.personId, m.term);
  }

  // The window worth asking about at all: from the earliest "last term" in this
  // batch up to the cycle's term. One query for the page rather than one per
  // applicant.
  const earliest = [...lastByPerson.values()].reduce(
    (min, t) => (t.startDate < min ? t.startDate : min),
    [...lastByPerson.values()][0].startDate,
  );

  const between = await prisma.term.findMany({
    where: { startDate: { gt: earliest, lt: cycleTerm.startDate } },
    select: { id: true, code: true, name: true, startDate: true },
    orderBy: { startDate: "asc" },
  });

  // Which of those the clinic actually staffed. A term with no ACTIVE membership
  // is a row in Admin, not a term anyone could have volunteered in.
  const staffed = between.length
    ? new Set(
        (
          await prisma.termMembership.groupBy({
            by: ["termId"],
            where: { termId: { in: between.map((t) => t.id) }, status: "ACTIVE" },
          })
        ).map((r) => r.termId),
      )
    : new Set<string>();
  const ranTerms = between.filter((t) => staffed.has(t.id));

  for (const [personId, last] of lastByPerson) {
    out.set(personId, {
      lastTerm: { code: last.code, name: last.name },
      missedTerms: ranTerms
        .filter((t) => t.startDate > last.startDate)
        .map((t) => ({ code: t.code, name: t.name })),
    });
  }
  return out;
}

/** One person's service gap. Null when they have never served. */
export async function serviceGapForCycle(
  personId: string,
  cycleTermId: string,
): Promise<ServiceGap | null> {
  const map = await serviceGapsForCycle([personId], cycleTermId);
  return map.get(personId) ?? null;
}
