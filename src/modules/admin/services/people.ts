/**
 * Admin people service: search, get, create, update, setStatus.
 *
 * Queries (searchPeople / getPerson) live here. The mutation core (diff,
 * audit, typed errors, P2002 mapping) now lives in
 * `src/platform/people.ts` so it can be shared with the member-facing my-info
 * module without crossing module boundaries. This service is a thin delegation
 * layer over that core and re-exports the error classes and PersonInput so
 * existing imports of `@/modules/admin/services/people` keep working unchanged.
 *
 * All mutations accept an explicit actorPersonId for audit. Permission checks
 * are NOT the service's concern -- pages and server actions gate via
 * requirePermission. Services trust their callers and remain testable in
 * isolation.
 *
 * NOTE: person merge tooling is deferred. Duplicates should be resolved in
 * Airtable and re-imported via the import pipeline.
 */

import type { Person, TermMembership, Term, Department, Prisma } from "@prisma/client";
import { prisma } from "@/platform/db";
import {
  PersonConflictError,
  PersonNotFoundError,
  createPersonRecord,
  updatePersonFields,
  setPersonStatusField,
} from "@/platform/people";
import type { PersonInput, SetPersonStatusOptions } from "@/platform/people";
import { PERSON_NAME_ORDER, personNameSearchClauses } from "@/platform/person-name";

// Re-export the mutation-core types/errors so callers that import from this
// module (the historical home of these symbols) keep working unchanged.
export { PersonConflictError, PersonNotFoundError };
export type { PersonInput };

export type PeopleQuery = {
  search?: string;
  status?: "ACTIVE" | "OFFBOARDED";
  /** The review queue: only people whose name split was guessed at. */
  needsNameReview?: boolean;
  page?: number;
  pageSize?: number;
};

export async function searchPeople(q: PeopleQuery): Promise<{
  rows: Person[];
  total: number;
  page: number;
  pageCount: number;
  /**
   * How many people in the whole table carry a guessed name split, independent
   * of the current filter. Drives the review-queue banner, which has to be
   * visible from the unfiltered list or nobody would find the queue.
   */
  needsNameReviewCount: number;
}> {
  const page = q.page ?? 1;
  const pageSize = q.pageSize ?? 25;
  const skip = (page - 1) * pageSize;

  const where: Prisma.PersonWhereInput = {};

  const term = q.search?.trim();
  if (term) {
    where.OR = [
      // `name` holds the PREFERRED display name, so a legal first name is no
      // longer a substring of it: the shared helper covers the display name,
      // both legal names and the surname, which is one column more than this
      // was hand-rolling. The middle name is the part nothing else can find.
      ...personNameSearchClauses(term),
      { netId: { contains: term, mode: "insensitive" } },
      { contactEmail: { contains: term, mode: "insensitive" } },
    ];
  }

  if (q.status) {
    where.status = q.status;
  }

  if (q.needsNameReview) {
    where.nameNeedsReview = true;
  }

  const [rows, total, needsNameReviewCount] = await Promise.all([
    prisma.person.findMany({
      where,
      // Total order: name is non-unique with no index, so two people with the
      // same name tie on the whole sort key and Postgres may order them
      // differently across page boundaries, dropping one and repeating the other.
      // The id tiebreaker makes paging stable.
      orderBy: PERSON_NAME_ORDER,
      skip,
      take: pageSize,
    }),
    prisma.person.count({ where }),
    prisma.person.count({ where: { nameNeedsReview: true } }),
  ]);

  const pageCount = Math.max(1, Math.ceil(total / pageSize));

  return { rows, total, page, pageCount, needsNameReviewCount };
}

export async function getPerson(
  id: string
): Promise<(Person & { memberships: (TermMembership & { term: Term; department: Department })[] }) | null> {
  return prisma.person.findUnique({
    where: { id },
    include: {
      memberships: {
        include: { term: true, department: true },
      },
    },
  });
}

export function createPerson(actorPersonId: string, input: PersonInput): Promise<Person> {
  return createPersonRecord(actorPersonId, input);
}

export function updatePerson(
  actorPersonId: string,
  id: string,
  input: Partial<PersonInput>
): Promise<Person> {
  return updatePersonFields(actorPersonId, id, input);
}

export function setPersonStatus(
  actorPersonId: string,
  id: string,
  status: "ACTIVE" | "OFFBOARDED",
  opts: SetPersonStatusOptions = {}
): Promise<Person> {
  return setPersonStatusField(actorPersonId, id, status, opts);
}
