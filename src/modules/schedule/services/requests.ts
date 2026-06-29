/**
 * Shift request service for HAVEN Hub.
 *
 * Scoping model:
 *   - createRequest/cancelRequest: requester-only; no scope check needed beyond
 *     verifying assignment ownership.
 *   - listDepartmentRequests, approveRequest, denyRequest: restricted to actors
 *     who are active directors of the department (or a one-hop delegated manager,
 *     or hold the schedule.edit_all permission).
 *
 * All mutation operations run inside a single $transaction to prevent races.
 * Approval re-validates via the engine before applying mutations.
 */

import type { ShiftRequest } from "@prisma/client";
import { Prisma } from "@prisma/client";
import { prisma } from "@/platform/db";
import { recordAudit } from "@/platform/audit";
import { isoDateKey } from "@/platform/dates";
import { manageableDepartmentIds, memberDepartmentIds } from "@/platform/departments";
import { can } from "@/platform/rbac/engine";
import {
  validateRequest,
  planApply,
} from "../engine/requests";
import type { ScheduleRowForValidation } from "../engine/requests";

// ---------------------------------------------------------------------------
// Typed errors
// ---------------------------------------------------------------------------

/** Actor lacks permission to perform the operation on this department. */
export class RequestForbiddenError extends Error {
  constructor(message = "Forbidden") {
    super(message);
    this.name = "RequestForbiddenError";
  }
}

/** No ShiftRequest matching the provided id was found. */
export class RequestNotFoundError extends Error {
  constructor(message = "Request not found") {
    super(message);
    this.name = "RequestNotFoundError";
  }
}

/** The request input is invalid or conflicts with schedule state. */
export class RequestValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RequestValidationError";
  }
}

// ---------------------------------------------------------------------------
// Exported shape
// ---------------------------------------------------------------------------

export type RequestRow = {
  request: ShiftRequest;
  requesterName: string;
  targetName: string | null;
  decidedByName: string | null;
};

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/** Returns the active term or null. */
async function getActiveTerm() {
  return prisma.term.findFirst({
    where: { status: "ACTIVE" },
    orderBy: { startDate: "desc" },
  });
}

/**
 * Builds ScheduleRowForValidation[] for a (term, department) pair by loading
 * all ShiftAssignments and grouping them by UTC date key.
 */
async function buildScheduleRows(
  termId: string,
  departmentId: string,
): Promise<ScheduleRowForValidation[]> {
  const assignments = await prisma.shiftAssignment.findMany({
    where: { termId, departmentId },
    select: { personId: true, clinicDate: true, role: true },
  });

  const byDate = new Map<string, ScheduleRowForValidation>();

  for (const a of assignments) {
    const key = isoDateKey(a.clinicDate);
    if (!byDate.has(key)) {
      byDate.set(key, { date: key, directorIds: [], volunteerIds: [], shadowIds: [] });
    }
    const row = byDate.get(key)!;
    if (a.role === "DIRECTOR") {
      row.directorIds.push(a.personId);
    } else if (a.role === "VOLUNTEER") {
      row.volunteerIds.push(a.personId);
    } else {
      row.shadowIds!.push(a.personId);
    }
  }

  return [...byDate.values()];
}

/**
 * Departments the actor may decide requests for: director membership +
 * one-hop delegation, UNION member departments when the actor holds
 * schedule.manage_requests, UNION all departments when schedule.edit_all.
 */
export async function manageableRequestDepartmentIds(personId: string): Promise<string[]> {
  const [base, manageRequests, editAll] = await Promise.all([
    manageableDepartmentIds(personId),
    can(personId, "schedule.manage_requests"),
    can(personId, "schedule.edit_all"),
  ]);

  const ids = new Set<string>(base);

  if (manageRequests) {
    for (const id of await memberDepartmentIds(personId)) ids.add(id);
  }

  if (editAll) {
    const all = await prisma.department.findMany({ select: { id: true } });
    for (const d of all) ids.add(d.id);
  }

  return [...ids];
}

/** True when the actor may decide requests for the given department. */
export async function canManageRequestsForDept(
  personId: string,
  departmentId: string,
): Promise<boolean> {
  return (await manageableRequestDepartmentIds(personId)).includes(departmentId);
}

/**
 * Checks that actor may decide requests for the given department.
 * Throws RequestForbiddenError if not.
 */
async function scopeCheck(actorPersonId: string, departmentId: string): Promise<void> {
  if (!(await canManageRequestsForDept(actorPersonId, departmentId))) {
    throw new RequestForbiddenError();
  }
}

// ---------------------------------------------------------------------------
// assertNoSwapCollision
// ---------------------------------------------------------------------------

/**
 * Guards against same-date-other-role collisions that the engine's validateRequest
 * does not cover.
 *
 * Background: planApply emits "add" ops for named swaps which the service applies
 * via upsert (update role on conflict). The unique constraint on
 * (termId, departmentId, clinicDate, personId) means a single row per person per
 * date. If the target already holds a SHADOW assignment on the requester's date,
 * the upsert would silently overwrite that row's role. Symmetrically, if the
 * requester holds any assignment on the target's date, their new add-row would
 * clobber it. validateRequest only verifies that each party has an assignment on
 * their own offered date in the correct role; the cross-date collision check is
 * the service's responsibility.
 *
 * Throws RequestValidationError("Partner is not eligible") when:
 *   - the target holds ANY assignment on requesterDate (in this term + department), or
 *   - the requester holds ANY assignment on targetDate (in this term + department).
 */
async function assertNoSwapCollision(
  termId: string,
  departmentId: string,
  requesterId: string,
  requesterDate: Date,
  targetId: string,
  targetDate: Date,
  tx?: Parameters<Parameters<typeof prisma.$transaction>[0]>[0],
): Promise<void> {
  const db = tx ?? prisma;

  const [targetOnRequesterDate, requesterOnTargetDate] = await Promise.all([
    db.shiftAssignment.findFirst({
      where: { termId, departmentId, personId: targetId, clinicDate: requesterDate },
      select: { id: true },
    }),
    db.shiftAssignment.findFirst({
      where: { termId, departmentId, personId: requesterId, clinicDate: targetDate },
      select: { id: true },
    }),
  ]);

  if (targetOnRequesterDate || requesterOnTargetDate) {
    throw new RequestValidationError("Partner is not eligible");
  }
}

// ---------------------------------------------------------------------------
// createRequest
// ---------------------------------------------------------------------------

/**
 * Creates a PENDING shift drop or swap request for the actor.
 *
 * Validates that:
 *   - An active term exists.
 *   - requesterDateKey and (if provided) targetDateKey resolve to canonical
 *     clinic dates in the term.
 *   - The actor holds an assignment on requesterDateKey in the department.
 *   - The engine validateRequest passes.
 *   - No PENDING request already exists for (requesterId, requesterDate, departmentId).
 */
export async function createRequest(
  actorPersonId: string,
  input: {
    requesterDateKey: string;
    departmentId: string;
    targetId?: string;
    targetDateKey?: string;
    note?: string;
  },
): Promise<ShiftRequest> {
  const term = await getActiveTerm();
  if (!term) {
    throw new RequestValidationError("No active term.");
  }

  // Resolve requesterDate from clinic dates
  const clinicDateMap = new Map<string, Date>();
  for (const d of term.clinicDates) {
    clinicDateMap.set(isoDateKey(d), d);
  }

  const canonicalRequesterDate = clinicDateMap.get(input.requesterDateKey);
  if (!canonicalRequesterDate) {
    throw new RequestValidationError(
      `${input.requesterDateKey} is not a clinic date in the active term.`,
    );
  }

  // Resolve optional targetDate
  let canonicalTargetDate: Date | null = null;
  if (input.targetDateKey !== undefined) {
    const d = clinicDateMap.get(input.targetDateKey);
    if (!d) {
      throw new RequestValidationError(
        `${input.targetDateKey} is not a clinic date in the active term.`,
      );
    }
    canonicalTargetDate = d;
  }

  // Build schedule rows and run engine validation
  const scheduleRows = await buildScheduleRows(term.id, input.departmentId);

  const validationResult = validateRequest({
    scheduleRows,
    requesterId: actorPersonId,
    requesterDate: input.requesterDateKey,
    targetId: input.targetId,
    targetDate: input.targetDateKey,
  });

  if (!validationResult.ok) {
    throw new RequestValidationError(validationResult.error);
  }

  // Swap collision guard: the engine does not check for cross-date same-person
  // rows. If the target has any assignment on the requester's date (or vice versa),
  // the upsert in planApply would clobber that row's role.
  if (input.targetId && canonicalTargetDate) {
    await assertNoSwapCollision(
      term.id,
      input.departmentId,
      actorPersonId,
      canonicalRequesterDate,
      input.targetId,
      canonicalTargetDate,
    );
  }

  // Duplicate guard + create inside a transaction.
  // The in-tx findFirst gives a friendly error for the sequential case.
  // The partial unique index "ShiftRequest_pending_unique" is the race-window
  // backstop: if two concurrent requests slip through we catch P2002 and
  // surface the same user-facing message.
  let created: ShiftRequest;
  try {
    created = await prisma.$transaction(async (tx) => {
      const existing = await tx.shiftRequest.findFirst({
        where: {
          requesterId: actorPersonId,
          requesterDate: canonicalRequesterDate,
          departmentId: input.departmentId,
          status: "PENDING",
        },
      });

      if (existing) {
        throw new RequestValidationError(
          "You already have a pending request for this shift.",
        );
      }

      return tx.shiftRequest.create({
        data: {
          termId: term.id,
          requesterId: actorPersonId,
          requesterDate: canonicalRequesterDate,
          departmentId: input.departmentId,
          targetId: input.targetId ?? null,
          targetDate: canonicalTargetDate,
          note: input.note ?? null,
          status: "PENDING",
        },
      });
    });
  } catch (err) {
    // Race backstop: two concurrent createRequest calls can both pass the
    // in-tx findFirst check before either commits; the partial unique index
    // then rejects the second insert with a unique violation (P2002).
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      throw new RequestValidationError("You already have a pending request for this shift.");
    }
    throw err;
  }

  const isSwap = !!(input.targetId && input.targetDateKey);
  await recordAudit({
    actorPersonId,
    action: "schedule.request",
    entityType: "ShiftRequest",
    entityId: created.id,
    after: {
      type: isSwap ? "swap" : "drop",
      dateKey: input.requesterDateKey,
      targetId: input.targetId ?? null,
      targetDateKey: input.targetDateKey ?? null,
    },
  });

  return created;
}

// ---------------------------------------------------------------------------
// cancelRequest
// ---------------------------------------------------------------------------

/**
 * Cancels a PENDING shift request.
 *
 * Only the original requester may cancel. Only PENDING requests can be cancelled.
 */
export async function cancelRequest(
  actorPersonId: string,
  requestId: string,
): Promise<void> {
  const req = await prisma.shiftRequest.findUnique({ where: { id: requestId } });
  if (!req) {
    throw new RequestNotFoundError();
  }

  if (req.requesterId !== actorPersonId) {
    throw new RequestForbiddenError("Only the requester can cancel a request.");
  }

  if (req.status !== "PENDING") {
    throw new RequestValidationError("Only pending requests can be cancelled.");
  }

  await prisma.shiftRequest.update({
    where: { id: requestId },
    data: { status: "CANCELLED" },
  });

  await recordAudit({
    actorPersonId,
    action: "schedule.request_cancel",
    entityType: "ShiftRequest",
    entityId: requestId,
  });
}

// ---------------------------------------------------------------------------
// listDepartmentRequests
// ---------------------------------------------------------------------------

/**
 * Lists shift requests for a department in the active term.
 *
 * Ordering: PENDING first (createdAt asc), then decided (most recent first, max
 * 10 decided). The decided bucket sorts by updatedAt, not decidedAt: CANCELLED
 * rows are self-service withdrawals with no decider and a null decidedAt, so a
 * decidedAt-desc sort would float them ahead of every real decision (Postgres
 * sorts NULLS FIRST on DESC) and bury approvals/denials. updatedAt is the moment
 * each row reached its terminal state, giving a true chronological history.
 * Requires actor to be a manageable-department director or hold schedule.edit_all.
 */
export async function listDepartmentRequests(
  viewerPersonId: string,
  departmentId: string,
): Promise<RequestRow[]> {
  await scopeCheck(viewerPersonId, departmentId);

  const term = await getActiveTerm();
  if (!term) return [];

  const [pendingRows, decidedRows] = await Promise.all([
    prisma.shiftRequest.findMany({
      where: { termId: term.id, departmentId, status: "PENDING" },
      include: {
        requester: { select: { name: true } },
        target: { select: { name: true } },
        decidedBy: { select: { name: true } },
      },
      orderBy: { createdAt: "asc" },
    }),
    prisma.shiftRequest.findMany({
      where: {
        termId: term.id,
        departmentId,
        // CANCELLED rows share the decided bucket deliberately: self-service
      // withdrawals are part of recent history and relevant to directors.
      status: { in: ["APPROVED", "DENIED", "CANCELLED"] },
      },
      include: {
        requester: { select: { name: true } },
        target: { select: { name: true } },
        decidedBy: { select: { name: true } },
      },
      // Sort by updatedAt, not decidedAt: CANCELLED rows have a null decidedAt
      // and would otherwise sort NULLS FIRST, burying real approvals/denials.
      orderBy: { updatedAt: "desc" },
      take: 10,
    }),
  ]);

  const toRow = (r: (typeof pendingRows)[number]): RequestRow => ({
    request: r,
    requesterName: r.requester.name,
    targetName: r.target?.name ?? null,
    decidedByName: r.decidedBy?.name ?? null,
  });

  return [...pendingRows.map(toRow), ...decidedRows.map(toRow)];
}

// ---------------------------------------------------------------------------
// approveRequest
// ---------------------------------------------------------------------------

/**
 * Approves a PENDING shift request.
 *
 * Re-validates the request against the CURRENT schedule state before applying
 * mutations. If validation fails, throws RequestValidationError and leaves the
 * request PENDING.
 *
 * Applies all mutations (remove/add assignments) and marks the request APPROVED
 * in a single $transaction.
 */
export async function approveRequest(
  actorPersonId: string,
  requestId: string,
): Promise<void> {
  const req = await prisma.shiftRequest.findUnique({ where: { id: requestId } });
  if (!req) {
    throw new RequestNotFoundError();
  }

  await scopeCheck(actorPersonId, req.departmentId);

  if (req.status !== "PENDING") {
    throw new RequestValidationError("Only pending requests can be approved.");
  }

  // Re-validate against current schedule state
  const scheduleRows = await buildScheduleRows(req.termId, req.departmentId);

  const requesterDateKey = isoDateKey(req.requesterDate);
  const targetDateKey = req.targetDate ? isoDateKey(req.targetDate) : undefined;

  const validationResult = validateRequest({
    scheduleRows,
    requesterId: req.requesterId,
    requesterDate: requesterDateKey,
    targetId: req.targetId ?? undefined,
    targetDate: targetDateKey,
  });

  if (!validationResult.ok) {
    throw new RequestValidationError(validationResult.error);
  }

  // Swap collision guard (re-checked at approval time against current data).
  // Must run before the transaction so a collision discovered here keeps the
  // request PENDING and leaves all assignments untouched.
  if (req.targetId && req.targetDate) {
    await assertNoSwapCollision(
      req.termId,
      req.departmentId,
      req.requesterId,
      req.requesterDate,
      req.targetId,
      req.targetDate,
    );
  }

  // Plan mutations
  const mutations = planApply({
    scheduleRows,
    requesterId: req.requesterId,
    requesterDate: requesterDateKey,
    targetId: req.targetId ?? undefined,
    targetDate: targetDateKey,
  });

  // Fetch term clinic dates once (needed to resolve canonical Date objects).
  const term = await prisma.term.findUniqueOrThrow({
    where: { id: req.termId },
    select: { clinicDates: true },
  });
  const clinicDateMap = new Map<string, Date>();
  for (const d of term.clinicDates) {
    clinicDateMap.set(isoDateKey(d), d);
  }

  const now = new Date();

  await prisma.$transaction(async (tx) => {
    // In-transaction swap collision guard: a concurrent assignment could have
    // been created in the window between the pre-tx check above and this tx
    // acquiring its snapshot. Re-running inside the tx means any collision
    // created after the outer check rolls the whole transaction back.
    if (req.targetId && req.targetDate) {
      await assertNoSwapCollision(
        req.termId,
        req.departmentId,
        req.requesterId,
        req.requesterDate,
        req.targetId,
        req.targetDate,
        tx,
      );
    }

    // Apply mutations
    for (const mutation of mutations) {
      const dbRole = mutation.role.toUpperCase() as "DIRECTOR" | "VOLUNTEER" | "SHADOW";

      const canonicalDate = clinicDateMap.get(mutation.dateKey);
      if (!canonicalDate) {
        throw new RequestValidationError(
          `Clinic date ${mutation.dateKey} no longer exists in the term.`,
        );
      }

      if (mutation.op === "remove") {
        // Capture the delete count and assert exactly one row was removed.
        // The re-validation above (outside the tx) catches all deterministic
        // cases (e.g. assignment already deleted). This count guard is a
        // last-resort race backstop: if the row vanishes between validation
        // and this tx the delete would silently succeed with count=0, leaving
        // the schedule in a half-mutated state. Rolling back here keeps the
        // request PENDING so the director can retry with fresh state.
        const { count } = await tx.shiftAssignment.deleteMany({
          where: {
            termId: req.termId,
            departmentId: req.departmentId,
            clinicDate: canonicalDate,
            personId: mutation.personId,
            role: dbRole,
          },
        });
        if (count !== 1) {
          throw new RequestValidationError(
            "Schedule changed while approving; please retry.",
          );
        }
      } else {
        // Add idempotently: upsert on the unique key
        await tx.shiftAssignment.upsert({
          where: {
            termId_departmentId_clinicDate_personId: {
              termId: req.termId,
              departmentId: req.departmentId,
              clinicDate: canonicalDate,
              personId: mutation.personId,
            },
          },
          create: {
            termId: req.termId,
            departmentId: req.departmentId,
            clinicDate: canonicalDate,
            personId: mutation.personId,
            role: dbRole,
          },
          update: { role: dbRole },
        });
      }
    }

    // Mark request approved
    await tx.shiftRequest.update({
      where: { id: requestId },
      data: {
        status: "APPROVED",
        decidedById: actorPersonId,
        decidedAt: now,
      },
    });
  });

  await recordAudit({
    actorPersonId,
    action: "schedule.request_approve",
    entityType: "ShiftRequest",
    entityId: requestId,
    after: {
      mutations: mutations.map((m) => ({
        op: m.op,
        personId: m.personId,
        dateKey: m.dateKey,
        role: m.role,
      })),
    },
  });
}

// ---------------------------------------------------------------------------
// denyRequest
// ---------------------------------------------------------------------------

/**
 * Denies a PENDING shift request.
 *
 * When a note is provided it is appended to the existing request note as
 * "\nDenied: <note>".
 */
export async function denyRequest(
  actorPersonId: string,
  requestId: string,
  note?: string,
): Promise<void> {
  const req = await prisma.shiftRequest.findUnique({ where: { id: requestId } });
  if (!req) {
    throw new RequestNotFoundError();
  }

  await scopeCheck(actorPersonId, req.departmentId);

  if (req.status !== "PENDING") {
    throw new RequestValidationError("Only pending requests can be denied.");
  }

  const now = new Date();
  let newNote = req.note ?? null;
  if (note) {
    newNote = newNote ? `${newNote}\nDenied: ${note}` : `Denied: ${note}`;
  }

  await prisma.shiftRequest.update({
    where: { id: requestId },
    data: {
      status: "DENIED",
      decidedById: actorPersonId,
      decidedAt: now,
      note: newNote,
    },
  });

  await recordAudit({
    actorPersonId,
    action: "schedule.request_deny",
    entityType: "ShiftRequest",
    entityId: requestId,
    after: { note: newNote },
  });
}

// ---------------------------------------------------------------------------
// eligibleSwapPartners
// ---------------------------------------------------------------------------

/**
 * Returns eligible swap partners for the actor in a given department.
 *
 * Eligible partners are persons assigned in the same department with the same
 * role as the actor on the actor's requesterDateKey, but on DIFFERENT dates.
 * Shadows cannot swap, so returns [] when the actor is a shadow.
 *
 * Results are sorted by dateKey then name.
 */
export async function eligibleSwapPartners(
  actorPersonId: string,
  requesterDateKey: string,
  departmentId: string,
): Promise<Array<{ personId: string; name: string; dateKey: string }>> {
  const term = await getActiveTerm();
  if (!term) return [];

  // Find actor's role on the requester date
  const actorAssignment = await prisma.shiftAssignment.findFirst({
    where: {
      termId: term.id,
      departmentId,
      personId: actorPersonId,
      clinicDate: {
        in: term.clinicDates.filter((d) => isoDateKey(d) === requesterDateKey),
      },
    },
    select: { role: true },
  });

  if (!actorAssignment) return [];
  // Shadows cannot swap
  if (actorAssignment.role === "SHADOW") return [];

  const actorRole = actorAssignment.role;
  const requesterDates = term.clinicDates.filter((d) => isoDateKey(d) === requesterDateKey);

  const [partners, actorAssignments, othersOnRequesterDate] = await Promise.all([
    // Same-dept, same-role assignments on different dates, excluding actor.
    prisma.shiftAssignment.findMany({
      where: {
        termId: term.id,
        departmentId,
        role: actorRole,
        personId: { not: actorPersonId },
        clinicDate: { notIn: requesterDates },
      },
      select: {
        personId: true,
        clinicDate: true,
        person: { select: { name: true } },
      },
    }),
    // Every date the actor is already assigned in this department (any role).
    prisma.shiftAssignment.findMany({
      where: { termId: term.id, departmentId, personId: actorPersonId },
      select: { clinicDate: true },
    }),
    // Anyone else holding an assignment on the requester's date (any role).
    prisma.shiftAssignment.findMany({
      where: {
        termId: term.id,
        departmentId,
        personId: { not: actorPersonId },
        clinicDate: { in: requesterDates },
      },
      select: { personId: true },
    }),
  ]);

  // Mirror assertNoSwapCollision so the dropdown only offers swaps createRequest
  // will accept. A partner is un-swappable when:
  //   - the actor already works the partner's date (requesterOnTargetDate), or
  //   - the partner also works the actor's requester date (targetOnRequesterDate).
  const actorBusyDateKeys = new Set(actorAssignments.map((a) => isoDateKey(a.clinicDate)));
  const partnerIdsOnRequesterDate = new Set(othersOnRequesterDate.map((a) => a.personId));

  return partners
    .filter(
      (p) =>
        !actorBusyDateKeys.has(isoDateKey(p.clinicDate)) &&
        !partnerIdsOnRequesterDate.has(p.personId),
    )
    .map((p) => ({
      personId: p.personId,
      name: p.person.name,
      dateKey: isoDateKey(p.clinicDate),
    }))
    .sort((a, b) => a.dateKey.localeCompare(b.dateKey) || a.name.localeCompare(b.name));
}
