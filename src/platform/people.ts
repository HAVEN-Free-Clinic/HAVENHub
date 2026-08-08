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

import { Prisma, type Person } from "@prisma/client";
import { prisma, isUniqueConstraintError } from "@/platform/db";
import { recordAudit } from "@/platform/audit";
import { log, errorAttrs } from "@/platform/logging";
// One sanctioned platform -> module import, the same shape as the onboarding
// gate's exception in auth/session.ts and the clearance facade in
// clearance.ts. setPersonStatusField is the SINGLE convergence point for
// every offboard path (admin people page and the volunteers executeOffboard
// flow both call here -- see the docstring below), and OFFBOARDABLE_TERM
// means the current term's membership is about to become REMOVED. Snapshotting
// the service record has to happen before that flip, or a graduating member's
// final term is lost; there is no platform-owned home for that snapshot logic
// to move to. See the call site below for why it runs before, but outside,
// the offboard transaction.
// eslint-disable-next-line no-restricted-imports, import/no-restricted-paths
import { issueServiceCredential } from "@/modules/passport/services/credential";
// eslint-disable-next-line no-restricted-imports, import/no-restricted-paths
import { revokeWalletPasses } from "@/modules/passport/services/wallet-pass";

/**
 * The terms an offboard is allowed to touch: everything except ARCHIVED.
 *
 * Offboarding answers "does this person still have a place here", which is a
 * question about live and upcoming terms. An ARCHIVED term's roster is a
 * historical record of who served then -- it grants nothing (every
 * permission-, roster- and schedule-bearing query scopes to the ACTIVE term)
 * and it is not the offboard's to rewrite. Without this, importing a past
 * term's roster (see airtable/import/historical-term.ts) meant the next
 * offboard silently flipped that person's history to REMOVED, and no re-import
 * would repair it because the import never overwrites an existing row.
 *
 * Exported so the pre-flight count in volunteers/services/offboarding.ts
 * reports exactly what the write below will change.
 */
export const OFFBOARDABLE_TERM = {
  term: { status: { not: "ARCHIVED" } },
} as const satisfies Pick<Prisma.TermMembershipWhereInput, "term">;

/**
 * Options for setPersonStatusField / setPersonStatus.
 *
 * assertInvariant runs inside the OFFBOARDED transaction, before any mutation,
 * and may throw to abort the whole flip atomically. Offboard call sites pass the
 * last-admin guard here so the check and the Person.status flip commit together
 * (see setPersonStatusField). When present, the transaction escalates to
 * Serializable so two concurrent offboards cannot both pass and lock everyone out.
 */
export type SetPersonStatusOptions = {
  assertInvariant?: (tx: Prisma.TransactionClient) => Promise<void>;
};

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
  if (isUniqueConstraintError(err)) {
    const rawField = (err.meta?.target as string[] | undefined)?.[0] ?? "field";
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
  dietaryRestrictions?: string | null;
  spanishSelfReported?: boolean;
  spanishVerified?: boolean;
  licensedRN?: boolean;
};

/**
 * Normalize identity values. netId and contactEmail are trimmed AND lowercased,
 * and a value that trims to empty becomes null. This is the single point every
 * caller (admin create/edit, my-info) shares, so it must be complete: login
 * resolution compares with a case-insensitive but WHITESPACE-sensitive `equals`,
 * and the ci-unique indexes are on lower(netId)/lower(contactEmail), so an
 * untrimmed " jc123 " neither matches at login nor collides with the clean value,
 * silently locking the person out and defeating the unique constraint. name is
 * trimmed too (never lowercased, never nulled).
 */
function normalize(input: PersonInput): PersonInput;
function normalize(input: Partial<PersonInput>): Partial<PersonInput>;
function normalize(input: Partial<PersonInput>): Partial<PersonInput> {
  return {
    ...input,
    ...(input.name !== undefined && { name: input.name?.trim() ?? input.name }),
    ...(input.netId !== undefined && { netId: input.netId?.trim().toLowerCase() || null }),
    ...(input.contactEmail !== undefined && { contactEmail: input.contactEmail?.trim().toLowerCase() || null }),
  };
}

export async function createPersonRecord(
  actorPersonId: string,
  input: PersonInput
): Promise<Person> {
  const data = normalize(input);

  try {
    const person = await prisma.person.create({
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

    // Await audit after the create completes. recordAudit never throws, so it
    // cannot abort the already-persisted mutation. We await (rather than
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

  const fields: Array<keyof PersonInput> = [
    "name",
    "netId",
    "contactEmail",
    "phone",
    "epicId",
    "yaleAffiliation",
    "gradYear",
    "dietaryRestrictions",
    "spanishSelfReported",
    "spanishVerified",
    "licensedRN",
  ];

  try {
    const txResult = await prisma.$transaction(async (tx) => {
      // Read the current row inside the transaction so the diff and the write
      // are atomic (no lost update between read and write).
      const current = await tx.person.findUnique({ where: { id: personId } });
      if (!current) throw new PersonNotFoundError(personId);

      // Compute the diff: only keys explicitly present in `input` that have a
      // different value from the existing row. Undefined input keys mean "leave
      // unchanged", null means "clear".
      const changedKeys: Array<keyof PersonInput> = [];
      for (const key of fields) {
        if (key in input) {
          const newVal = data[key] ?? null;
          const oldVal = (current as Record<string, unknown>)[key] ?? null;
          if (newVal !== oldVal) {
            changedKeys.push(key);
          }
        }
      }

      // No-op: nothing changed, skip write and audit.
      if (changedKeys.length === 0) {
        return { updated: current, changedKeys, beforeSnapshot: {} as Prisma.InputJsonObject };
      }

      const beforeSnapshot: Prisma.InputJsonObject = Object.fromEntries(
        changedKeys.map((k) => [k, (current as Record<string, unknown>)[k] ?? null])
      );

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

      const updated = await tx.person.update({ where: { id: personId }, data: updateData });
      return { updated, changedKeys, beforeSnapshot };
    });

    if (txResult.changedKeys.length === 0) {
      return txResult.updated;
    }

    const afterSnapshot: Prisma.InputJsonObject = Object.fromEntries(
      txResult.changedKeys.map((k) => [k, (txResult.updated as Record<string, unknown>)[k] ?? null])
    );

    // Await audit after the transaction commits. recordAudit never throws.
    await recordAudit({
      actorPersonId,
      action: "person.update",
      entityType: "Person",
      entityId: personId,
      before: txResult.beforeSnapshot,
      after: afterSnapshot,
    });

    return txResult.updated;
  } catch (err) {
    return toConflictError(err);
  }
}

/**
 * Cancel every open (PENDING/SUBMITTED) DEACTIVATE EpicRequest for a person,
 * because they are back: a returning person no longer owes a revocation.
 *
 * This is the reactivation half of the offboard convergence, extracted so every
 * writer that brings a Person back to ACTIVE can apply it inside its own
 * transaction. `setPersonStatusField` is one such writer; `promoteContracts`
 * (recruitment re-onboarding an offboarded person) is the other, and it used to
 * flip the status with a bare update, leaving the queued deactivation live so
 * IT later revoked Epic access from somebody who had just re-joined.
 *
 * Takes a transaction client so the cancellation and the status flip commit
 * together. Returns the ids it cancelled, for audit snapshots.
 */
export async function cancelOpenDeactivationRequestsTx(
  tx: Prisma.TransactionClient,
  personId: string
): Promise<string[]> {
  const openDeact = await tx.epicRequest.findMany({
    where: { personId, status: { in: ["PENDING", "SUBMITTED"] }, kind: "DEACTIVATE" },
    select: { id: true, notes: true },
  });
  if (openDeact.length === 0) return [];

  const line = "Cancelled: person reactivated";
  const ids = openDeact.map((r) => r.id);

  await tx.epicRequest.updateMany({
    where: { id: { in: ids } },
    data: { status: "CANCELLED", notes: line },
  });

  for (const r of openDeact) {
    if (!r.notes) continue;
    await tx.epicRequest.update({
      where: { id: r.id },
      data: { notes: `${r.notes}\n${line}` },
    });
  }

  return ids;
}

export async function setPersonStatusField(
  actorPersonId: string,
  personId: string,
  status: "ACTIVE" | "OFFBOARDED",
  opts: SetPersonStatusOptions = {}
): Promise<Person> {
  const existingOrNull = await prisma.person.findUnique({ where: { id: personId } });
  if (!existingOrNull) throw new PersonNotFoundError(personId);
  const existing = existingOrNull;

  // Offboarding is the single convergence point for every offboard path (the
  // admin people page AND the volunteers executeOffboard flow both call here).
  // A person can never be OFFBOARDED yet still appear as a current member: we
  // set their ACTIVE memberships in every NON-ARCHIVED term to REMOVED in the
  // same transaction as the status flip, because the compliance, disciplinary,
  // and offboarding rosters all key off TermMembership.status, not Person.status.
  // Reactivation is status-only -- it never restores memberships (which ones to
  // restore is ambiguous), matching the existing offboarding behavior.
  //
  // Epic access: offboarding also cancels any open NEW/MODIFY/RENEW requests
  // (a departing person must not remain in the actionable queue) and enqueues
  // one PENDING DEACTIVATE request when epicId is set. The create is guarded so
  // a second offboard call does not produce a duplicate (idempotent). On
  // reactivation the open DEACTIVATE request is cancelled: the person is back,
  // so revocation is no longer needed.
  //
  // Passport: offboarding also freezes a service-credential snapshot of the
  // person's current record (see the try/catch immediately below) before the
  // transaction removes their current term's membership.
  //
  // That snapshot is gated on this offboard being the one that actually removes
  // something (see snapshotWorthTaking below): re-taking it overwrites the only
  // copy with a strictly poorer one.
  let removedMemberships = 0;
  let cancelledEpicRequestIds: string[] = [];
  let deactivationRequestId: string | null = null;
  let cancelledDeactivationRequestIds: string[] = [];
  let cancelledShiftRequestCount = 0;

  // The snapshot is gated, because re-taking it DESTROYS data. Issuance upserts
  // the single ServiceCredential row and there is no history table, so whatever
  // a re-snapshot computes replaces the previous one outright. And a second
  // offboard can only ever compute LESS: the first one already flipped those
  // memberships to REMOVED, and reactivation is status-only and deliberately
  // does not restore them (see the comment above), so nothing can recompute the
  // terms the first offboard removed. The snapshot IS the preservation
  // mechanism. Two conditions, both required:
  //
  //   1. Not already OFFBOARDED. A repeat offboard of an offboarded person has
  //      nothing new to preserve, and the older snapshot is the richer one.
  //   2. This offboard is actually about to remove a membership. If the person
  //      holds none in OFFBOARDABLE_TERM scope, the flip below destroys no
  //      input, so a record computed after it is identical to one computed now
  //      -- there is nothing to freeze, and freezing anyway is exactly how an
  //      empty record lands on top of a good one (offboard, reactivate without
  //      restoring memberships, offboard again).
  //
  // Recruitment-derived service needs no protection here either way:
  // HistoricalApplication rows are untouched by an offboard, so that part of
  // the record stays computable forever and the member can still issue it from
  // /my-info.
  //
  // Reachable from executeOffboard and from a reactivated returning alum in
  // promotion.ts as well, which is why the gate lives at this chokepoint and
  // not at the call sites.
  const snapshotWorthTaking =
    status === "OFFBOARDED" &&
    existing.status !== "OFFBOARDED" &&
    (await prisma.termMembership.count({
      where: { personId, status: "ACTIVE", ...OFFBOARDABLE_TERM },
    })) > 0;

  if (snapshotWorthTaking) {
    // Freeze the service record while the current term's membership is still
    // ACTIVE. OFFBOARDABLE_TERM scopes the sweep below (inside the transaction)
    // to non-archived terms, so a graduating member's final term is about to
    // become REMOVED and a record computed after that point would silently
    // omit it. This has to run BEFORE the flip, but deliberately OUTSIDE the
    // $transaction below: issueServiceCredential's audit write
    // (recordAudit(..., tx)) is written to rethrow instead of swallow when
    // passed a transaction client (see audit.ts), because Postgres marks a
    // transaction aborted at the wire level the instant any statement in it
    // fails -- so a caught-and-continued failure in here would still poison
    // the transaction, and the very next statement (the termMembership
    // updateMany) would blow up uncaught with "current transaction is
    // aborted", rolling back the entire offboard. Calling it against the
    // singleton client here means it runs on its own connection with its own
    // best-effort audit (which swallows on that path), so nothing it does can
    // touch the offboard transaction. It is an upsert, so if the transaction
    // below is later aborted by assertInvariant, the snapshot just reflects
    // this still-active person's current, accurate record and is safely
    // overwritten by the next real issuance -- no incorrect state results.
    //
    // Best-effort: a credential failure must never block an offboard, which is
    // a safety-relevant operation (it revokes access). Log and continue.
    try {
      await issueServiceCredential(personId);
    } catch (error) {
      log.error("[passport] offboard snapshot failed", errorAttrs(error, { personId }));
    }
  }

  const updated = await prisma.$transaction(async (tx) => {
    if (status === "OFFBOARDED") {
      // Run the caller-supplied invariant (e.g. the last-admin guard) inside this
      // transaction BEFORE any mutation, so the check and the status flip commit
      // atomically. Throwing here rolls the whole offboard back.
      if (opts.assertInvariant) await opts.assertInvariant(tx);

      const { count } = await tx.termMembership.updateMany({
        where: { personId, status: "ACTIVE", ...OFFBOARDABLE_TERM },
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

      // Cancel the departing person's PENDING shift requests too (as requester or
      // swap target). Nothing else touched them, so they lingered in every approver
      // surface forever: counted in the Approvals badge, pinned atop the department
      // approvals list, and re-nagged to approvers ~every 3 days by the
      // schedule-reminders cron -- and could never be approved anyway, since a
      // departed participant fails the active-member check. (#134) System cancel:
      // status + note only, no decidedBy (not an approver decision).
      const cancelledShiftRequests = await tx.shiftRequest.updateMany({
        where: {
          status: "PENDING",
          OR: [{ requesterId: personId }, { targetId: personId }],
        },
        data: { status: "CANCELLED", note: "Cancelled: a participant was offboarded." },
      });
      cancelledShiftRequestCount = cancelledShiftRequests.count;

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
      // Reactivation: a returning person no longer owes a revocation. Shared with
      // promoteContracts so the two reactivation paths cannot drift again.
      cancelledDeactivationRequestIds = await cancelOpenDeactivationRequestsTx(tx, personId);
    }

    return tx.person.update({
      where: { id: personId },
      data: { status },
    });
  },
  // Escalate to Serializable only when an invariant must hold across the flip, so
  // concurrent offboards conflict-abort instead of both committing (write skew).
  // Other callers keep the default isolation and behavior.
  opts.assertInvariant
    ? { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
    : undefined);

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
        ? { removedMemberships, cancelledEpicRequestIds, deactivationRequestId, cancelledShiftRequestCount }
        : { cancelledDeactivationRequestIds }),
    },
  });

  // Outside the transaction on purpose: this makes a network call to the wallet
  // vendor, and a timeout inside the transaction would hold a database
  // connection open across a round trip and could roll back the offboard.
  // Best-effort; the reconciliation cron retries anything that fails here.
  if (status === "OFFBOARDED") {
    try {
      await revokeWalletPasses(personId);
    } catch (error) {
      log.error("[passport] offboard wallet revoke failed", errorAttrs(error, { personId }));
    }
  }

  return updated;
}
