/**
 * Person mutation core (platform-level).
 *
 * This module owns the transactional create/update/status mutations for
 * Person, including the changed-field diff, the P2002 -> typed-conflict
 * mapping, and the audit writes. It lives in the
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
  spanishSelfReported?: boolean;
  spanishVerified?: boolean;
  licensedRN?: boolean;
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
          spanishSelfReported: data.spanishSelfReported ?? false,
          spanishVerified: data.spanishVerified ?? false,
          licensedRN: data.licensedRN ?? false,
          // An admin setting "verified" on create is itself a verification event.
          ...(data.spanishVerified
            ? { spanishVerifiedAt: new Date(), spanishVerifiedById: actorPersonId }
            : {}),
        },
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
        spanishSelfReported: person.spanishSelfReported,
        spanishVerified: person.spanishVerified,
        licensedRN: person.licensedRN,
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
    "spanishSelfReported",
    "spanishVerified",
    "licensedRN",
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

  // No-op: nothing changed, skip write and audit.
  if (changedKeys.length === 0) {
    return existing;
  }

  const beforeSnapshot = Object.fromEntries(
    changedKeys.map((k) => [k, (existing as Record<string, unknown>)[k] ?? null])
  );

  try {
    const updated = await prisma.$transaction(async (tx) => {
      const updateData: Record<string, unknown> = {};
      for (const key of changedKeys) {
        updateData[key] = data[key] ?? null;
      }
      // Verification stamping: setting verified true records who/when; clearing
      // it returns the person to the interpreting-department review queue.
      if (changedKeys.includes("spanishVerified")) {
        if (data.spanishVerified) {
          updateData.spanishVerifiedAt = new Date();
          updateData.spanishVerifiedById = actorPersonId;
        } else {
          updateData.spanishVerifiedAt = null;
          updateData.spanishVerifiedById = null;
        }
      }

      const result = await tx.person.update({ where: { id: personId }, data: updateData });

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
  const existingOrNull = await prisma.person.findUnique({ where: { id: personId } });
  if (!existingOrNull) throw new PersonNotFoundError(personId);
  const existing = existingOrNull;

  // Offboarding is the single convergence point for every offboard path (the
  // admin people page AND the volunteers executeOffboard flow both call here).
  // A person can never be OFFBOARDED yet still appear as a current member: we
  // set ALL their ACTIVE memberships (any term) to REMOVED in the same
  // transaction as the status flip, because the compliance, disciplinary, and
  // offboarding rosters all key off TermMembership.status, not Person.status.
  // Reactivation is status-only -- it never restores memberships (which ones to
  // restore is ambiguous), matching the existing offboarding behavior.
  //
  // Epic access: offboarding also cancels any open NEW/MODIFY/RENEW requests
  // (a departing person must not remain in the actionable queue) and enqueues
  // one PENDING DEACTIVATE request when epicId is set. The create is guarded so
  // a second offboard call does not produce a duplicate (idempotent). On
  // reactivation the open DEACTIVATE request is cancelled: the person is back,
  // so revocation is no longer needed.
  let removedMemberships = 0;
  let cancelledEpicRequestIds: string[] = [];
  let deactivationRequestId: string | null = null;
  let cancelledDeactivationRequestIds: string[] = [];

  const updated = await prisma.$transaction(async (tx) => {
    if (status === "OFFBOARDED") {
      const { count } = await tx.termMembership.updateMany({
        where: { personId, status: "ACTIVE" },
        data: { status: "REMOVED" },
      });
      removedMemberships = count;

      // Cancel open access-granting requests. A person who has left should not
      // have a NEW/MODIFY/RENEW request lingering as actionable in the queue.
      // DEACTIVATE is intentionally excluded: it is the revocation task itself.
      const openGrants = await tx.epicRequest.findMany({
        where: {
          personId,
          status: { in: ["PENDING", "SUBMITTED"] },
          kind: { in: ["NEW", "MODIFY", "RENEW"] },
        },
        select: { id: true, notes: true },
      });
      for (const r of openGrants) {
        const line = "Cancelled: person offboarded";
        await tx.epicRequest.update({
          where: { id: r.id },
          data: { status: "CANCELLED", notes: r.notes ? `${r.notes}\n${line}` : line },
        });
      }
      cancelledEpicRequestIds = openGrants.map((r) => r.id);

      // Enqueue a deactivation task when there is recorded Epic access to
      // revoke and no open DEACTIVATE request already exists (idempotent).
      if (existing.epicId) {
        const openDeact = await tx.epicRequest.findFirst({
          where: { personId, status: { in: ["PENDING", "SUBMITTED"] }, kind: "DEACTIVATE" },
          select: { id: true },
        });
        if (!openDeact) {
          const created = await tx.epicRequest.create({
            data: { personId, kind: "DEACTIVATE", status: "PENDING", requestedById: actorPersonId },
            select: { id: true },
          });
          deactivationRequestId = created.id;
        }
      }
    } else if (status === "ACTIVE") {
      // Reactivation: a returning person no longer owes a revocation.
      const openDeact = await tx.epicRequest.findMany({
        where: { personId, status: { in: ["PENDING", "SUBMITTED"] }, kind: "DEACTIVATE" },
        select: { id: true, notes: true },
      });
      for (const r of openDeact) {
        const line = "Cancelled: person reactivated";
        await tx.epicRequest.update({
          where: { id: r.id },
          data: { status: "CANCELLED", notes: r.notes ? `${r.notes}\n${line}` : line },
        });
      }
      cancelledDeactivationRequestIds = openDeact.map((r) => r.id);
    }

    return tx.person.update({
      where: { id: personId },
      data: { status },
    });
  });

  const action = status === "OFFBOARDED" ? "person.offboard" : "person.reactivate";

  // Await audit. recordAudit never throws, so this cannot abort the mutation.
  // One audit row per status change is the contract callers rely on; the
  // membership count and Epic-request effects ride on that single row.
  await recordAudit({
    actorPersonId,
    action,
    entityType: "Person",
    entityId: personId,
    before: { status: existing.status },
    after: {
      status: updated.status,
      ...(status === "OFFBOARDED"
        ? { removedMemberships, cancelledEpicRequestIds, deactivationRequestId }
        : { cancelledDeactivationRequestIds }),
    },
  });

  return updated;
}
