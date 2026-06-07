/**
 * Admin people service: search, get, create, update, setStatus.
 *
 * Queries (searchPeople / getPerson) live here. The mutation core (diff,
 * audit, mirror enqueue, typed errors, P2002 mapping) now lives in
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
import type { PersonInput } from "@/platform/people";

// Re-export the mutation-core types/errors so callers that import from this
// module (the historical home of these symbols) keep working unchanged.
export { PersonConflictError, PersonNotFoundError };
export type { PersonInput };

export type PeopleQuery = {
  search?: string;
  status?: "ACTIVE" | "OFFBOARDED";
  page?: number;
  pageSize?: number;
};

export async function searchPeople(q: PeopleQuery): Promise<{
  rows: Person[];
  total: number;
  page: number;
  pageCount: number;
}> {
  const page = q.page ?? 1;
  const pageSize = q.pageSize ?? 25;
  const skip = (page - 1) * pageSize;

  const where: Prisma.PersonWhereInput = {};

  const term = q.search?.trim();
  if (term) {
    where.OR = [
      { name: { contains: term, mode: "insensitive" } },
      { netId: { contains: term, mode: "insensitive" } },
      { contactEmail: { contains: term, mode: "insensitive" } },
    ];
  }

  if (q.status) {
    where.status = q.status;
  }

  const [rows, total] = await Promise.all([
    prisma.person.findMany({
      where,
      orderBy: { name: "asc" },
      skip,
      take: pageSize,
    }),
    prisma.person.count({ where }),
  ]);

  const pageCount = Math.max(1, Math.ceil(total / pageSize));

  return { rows, total, page, pageCount };
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
  status: "ACTIVE" | "OFFBOARDED"
): Promise<Person> {
  return setPersonStatusField(actorPersonId, id, status);
}
