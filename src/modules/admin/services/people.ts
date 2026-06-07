/**
 * People service: search, get, create, update, setStatus.
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
import { recordAudit } from "@/platform/audit";
import { enqueueMirror } from "@/platform/outbox";
import { ALL_PEOPLE_FIELDS } from "@/platform/airtable/fields";

// The set of Person field names that are mirrored to Airtable.
// Derived from the keys of ALL_PEOPLE_FIELDS so that the list stays in sync
// with the field registry automatically.
const MIRRORED_FIELDS = new Set(Object.keys(ALL_PEOPLE_FIELDS) as Array<keyof typeof ALL_PEOPLE_FIELDS>);

export class PersonConflictError extends Error {
  constructor(public field: string) {
    super(`A person with that ${field} already exists.`);
    this.name = "PersonConflictError";
  }
}

/** Wrap a Prisma unique-constraint error into a typed PersonConflictError. */
function toConflictError(err: unknown): never {
  if (
    err != null &&
    typeof err === "object" &&
    "code" in err &&
    (err as { code: string }).code === "P2002"
  ) {
    const meta = (err as { meta?: { target?: string[] } }).meta;
    const field = meta?.target?.[0] ?? "field";
    throw new PersonConflictError(field);
  }
  throw err;
}

/** Normalize values that must be lowercase (ids, emails). */
function normalize(input: PersonInput): PersonInput {
  return {
    ...input,
    netId: input.netId?.toLowerCase() ?? input.netId,
    contactEmail: input.contactEmail?.toLowerCase() ?? input.contactEmail,
    yaleEmail: input.yaleEmail?.toLowerCase() ?? input.yaleEmail,
  };
}

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

  if (q.search) {
    where.OR = [
      { name: { contains: q.search, mode: "insensitive" } },
      { netId: { contains: q.search, mode: "insensitive" } },
      { contactEmail: { contains: q.search, mode: "insensitive" } },
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

export type PersonInput = {
  name: string;
  netId?: string | null;
  contactEmail?: string | null;
  yaleEmail?: string | null;
  phone?: string | null;
  epicId?: string | null;
  yaleAffiliation?: string | null;
  gradYear?: string | null;
};

export async function createPerson(actorPersonId: string, input: PersonInput): Promise<Person> {
  const data = normalize(input);

  try {
    const person = await prisma.$transaction(async (tx) => {
      const created = await tx.person.create({
        data: {
          name: data.name,
          netId: data.netId ?? null,
          contactEmail: data.contactEmail ?? null,
          yaleEmail: data.yaleEmail ?? null,
          phone: data.phone ?? null,
          epicId: data.epicId ?? null,
          yaleAffiliation: data.yaleAffiliation ?? null,
          gradYear: data.gradYear ?? null,
        },
      });

      await enqueueMirror(tx, {
        entityType: "Person",
        entityId: created.id,
        changedFields: Array.from(MIRRORED_FIELDS),
      });

      return created;
    });

    // Await audit after the transaction commits. recordAudit never throws, so
    // it cannot abort the already-committed mutation. We await (rather than
    // fire-and-forget with void) so tests can assert the row exists immediately.
    await recordAudit({
      actorPersonId,
      action: "person.create",
      entityType: "Person",
      entityId: person.id,
      after: {
        name: person.name,
        netId: person.netId,
        contactEmail: person.contactEmail,
        yaleEmail: person.yaleEmail,
        phone: person.phone,
        epicId: person.epicId,
        yaleAffiliation: person.yaleAffiliation,
        gradYear: person.gradYear,
      },
    });

    return person;
  } catch (err) {
    return toConflictError(err);
  }
}

export async function updatePerson(
  actorPersonId: string,
  id: string,
  input: PersonInput
): Promise<Person> {
  const data = normalize(input);

  const existing = await prisma.person.findUniqueOrThrow({ where: { id } });

  // Compute the diff: only keys explicitly present in `input` that have a
  // different value from the existing row. Undefined input keys mean "leave
  // unchanged", null means "clear".
  const changedKeys: Array<keyof PersonInput> = [];

  const fields: Array<keyof PersonInput> = [
    "name",
    "netId",
    "contactEmail",
    "yaleEmail",
    "phone",
    "epicId",
    "yaleAffiliation",
    "gradYear",
  ];

  for (const key of fields) {
    if (key in input) {
      const newVal = data[key] ?? null;
      const oldVal = (existing as Record<string, unknown>)[key] ?? null;
      if (newVal !== oldVal) {
        changedKeys.push(key);
      }
    }
  }

  // No-op: nothing changed, skip write, audit, and mirror.
  if (changedKeys.length === 0) {
    return existing;
  }

  const changedMirroredFields = changedKeys.filter((k) =>
    MIRRORED_FIELDS.has(k as keyof typeof ALL_PEOPLE_FIELDS)
  );

  const beforeSnapshot = Object.fromEntries(
    changedKeys.map((k) => [k, (existing as Record<string, unknown>)[k] ?? null])
  );

  try {
    const updated = await prisma.$transaction(async (tx) => {
      const updateData: Record<string, unknown> = {};
      for (const key of changedKeys) {
        updateData[key] = data[key] ?? null;
      }

      const result = await tx.person.update({ where: { id }, data: updateData });

      if (changedMirroredFields.length > 0) {
        await enqueueMirror(tx, {
          entityType: "Person",
          entityId: id,
          changedFields: changedMirroredFields,
        });
      }

      return result;
    });

    const afterSnapshot = Object.fromEntries(
      changedKeys.map((k) => [k, (updated as Record<string, unknown>)[k] ?? null])
    );

    // Await audit after the transaction commits. recordAudit never throws.
    await recordAudit({
      actorPersonId,
      action: "person.update",
      entityType: "Person",
      entityId: id,
      before: beforeSnapshot,
      after: afterSnapshot,
    });

    return updated;
  } catch (err) {
    return toConflictError(err);
  }
}

export async function setPersonStatus(
  actorPersonId: string,
  id: string,
  status: "ACTIVE" | "OFFBOARDED"
): Promise<Person> {
  // Status is not a mirrored field. The offboarding checkbox flow in Airtable
  // belongs to the Volunteers module later. We do not enqueue a mirror job here.
  const existing = await prisma.person.findUniqueOrThrow({ where: { id } });

  const updated = await prisma.person.update({
    where: { id },
    data: { status },
  });

  const action = status === "OFFBOARDED" ? "person.offboard" : "person.reactivate";

  // Await audit. recordAudit never throws, so this cannot abort the mutation.
  await recordAudit({
    actorPersonId,
    action,
    entityType: "Person",
    entityId: id,
    before: { status: existing.status },
    after: { status: updated.status },
  });

  return updated;
}
