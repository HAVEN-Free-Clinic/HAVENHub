/**
 * Person mutation core (platform-level).
 *
 * This module owns the transactional create/update/status mutations for
 * Person, including the changed-field diff, the Airtable mirror enqueue, the
 * P2002 -> typed-conflict mapping, and the audit writes. It lives in the
 * platform layer (not inside any module) so that both the admin module and the
 * member-facing my-info module can drive person mutations without one module
 * importing another.
 *
 * All mutations accept an explicit actorPersonId for audit. Permission checks
 * are NOT this layer's concern -- pages and server actions gate via
 * requirePermission / a service whitelist. This core trusts its callers and
 * remains testable in isolation.
 *
 * Audit action names are preserved across the extraction:
 *   person.create / person.update / person.offboard / person.reactivate
 */

import type { Person } from "@prisma/client";
import { prisma } from "@/platform/db";
import { recordAudit } from "@/platform/audit";
import { enqueueMirror } from "@/platform/outbox";
import { ALL_PEOPLE_FIELDS } from "@/platform/airtable/fields";

// The set of Person field names that are mirrored to Airtable.
// Derived from the keys of ALL_PEOPLE_FIELDS so that the list stays in sync
// with the field registry automatically.
export const MIRRORED_FIELDS = new Set(
  Object.keys(ALL_PEOPLE_FIELDS) as Array<keyof typeof ALL_PEOPLE_FIELDS>
);

export class PersonConflictError extends Error {
  constructor(public field: string) {
    super(`A person with that ${field} already exists.`);
    this.name = "PersonConflictError";
  }
}

export class PersonNotFoundError extends Error {
  constructor(public id: string) {
    super(`Person ${id} not found`);
    this.name = "PersonNotFoundError";
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
    const rawField = meta?.target?.[0] ?? "field";
    const field = rawField.replace(/^lower\((.+)\)$/, "$1");
    throw new PersonConflictError(field);
  }
  throw err;
}

export type PersonInput = {
  name: string;
  netId?: string | null;
  contactEmail?: string | null;
  phone?: string | null;
  epicId?: string | null;
  yaleAffiliation?: string | null;
  gradYear?: string | null;
};

/** Normalize values that must be lowercase (ids, emails). */
function normalize(input: PersonInput): PersonInput;
function normalize(input: Partial<PersonInput>): Partial<PersonInput>;
function normalize(input: Partial<PersonInput>): Partial<PersonInput> {
  return {
    ...input,
    ...(input.netId !== undefined && { netId: input.netId?.toLowerCase() ?? input.netId }),
    ...(input.contactEmail !== undefined && { contactEmail: input.contactEmail?.toLowerCase() ?? input.contactEmail }),
  };
}

export async function createPersonRecord(
  actorPersonId: string,
  input: PersonInput
): Promise<Person> {
  const data = normalize(input);

  try {
    const person = await prisma.$transaction(async (tx) => {
      const created = await tx.person.create({
        data: {
          name: data.name,
          netId: data.netId ?? null,
          contactEmail: data.contactEmail ?? null,
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

export async function updatePersonFields(
  actorPersonId: string,
  personId: string,
  input: Partial<PersonInput>
): Promise<Person> {
  const data = normalize(input);

  const existingOrNull = await prisma.person.findUnique({ where: { id: personId } });
  if (!existingOrNull) throw new PersonNotFoundError(personId);
  const existing = existingOrNull;

  // Compute the diff: only keys explicitly present in `input` that have a
  // different value from the existing row. Undefined input keys mean "leave
  // unchanged", null means "clear".
  const changedKeys: Array<keyof PersonInput> = [];

  const fields: Array<keyof PersonInput> = [
    "name",
    "netId",
    "contactEmail",
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

      const result = await tx.person.update({ where: { id: personId }, data: updateData });

      if (changedMirroredFields.length > 0) {
        await enqueueMirror(tx, {
          entityType: "Person",
          entityId: personId,
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
      entityId: personId,
      before: beforeSnapshot,
      after: afterSnapshot,
    });

    return updated;
  } catch (err) {
    return toConflictError(err);
  }
}

export async function setPersonStatusField(
  actorPersonId: string,
  personId: string,
  status: "ACTIVE" | "OFFBOARDED"
): Promise<Person> {
  // Status is not a mirrored field. The offboarding checkbox flow in Airtable
  // belongs to the Volunteers module later. We do not enqueue a mirror job here.
  const existingOrNull = await prisma.person.findUnique({ where: { id: personId } });
  if (!existingOrNull) throw new PersonNotFoundError(personId);
  const existing = existingOrNull;

  const updated = await prisma.person.update({
    where: { id: personId },
    data: { status },
  });

  const action = status === "OFFBOARDED" ? "person.offboard" : "person.reactivate";

  // Await audit. recordAudit never throws, so this cannot abort the mutation.
  await recordAudit({
    actorPersonId,
    action,
    entityType: "Person",
    entityId: personId,
    before: { status: existing.status },
    after: { status: updated.status },
  });

  return updated;
}
