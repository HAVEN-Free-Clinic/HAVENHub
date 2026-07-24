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
import { prisma, isUniqueConstraintError } from "@/platform/db";
import { recordAudit } from "@/platform/audit";
import { formatCalendarDate, isoDateKey } from "@/platform/dates";
import {
  departmentDirectorPersonIds,
  manageableDepartmentIds,
  memberDepartmentIds,
} from "@/platform/departments";
import { can } from "@/platform/rbac/engine";
import {
  validateRequest,
  planApply,
} from "../engine/requests";
import type { ScheduleRowForValidation } from "../engine/requests";
import { getPersonTerms } from "@/platform/terms/person-terms";
import { isPublished } from "./publication";
import { queueEmail } from "@/platform/email/send";
import { renderEmail } from "@/platform/email/templates/renderEmail";
import { getSetting } from "@/platform/settings/service";

// ---------------------------------------------------------------------------
// Typed errors
// ---------------------------------------------------------------------------

export class RequestForbiddenError extends Error {
  constructor(message = "Forbidden") {
    super(message);
    this.name = "RequestForbiddenError";
  }
}

export class RequestNotFoundError extends Error {
  constructor(message = "Request not found") {
    super(message);
    this.name = "RequestNotFoundError";
  }
}

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

export async function canManageRequestsForDept(
  personId: string,
  departmentId: string,
): Promise<boolean> {
  return (await manageableRequestDepartmentIds(personId)).includes(departmentId);
}

/**
 * How many PENDING shift-change requests this person is responsible for deciding,
 * across every department they can manage requests for, in the active term. Used
 * by the dashboard action feed. Returns 0 when there is no active term or the
 * person manages no departments. One count query; reuses the same scope resolver
 * as the approve/deny path.
 */
export async function countPendingApprovals(personId: string): Promise<number> {
  // Every department the person can approve/deny requests for. The dashboard
  // Approvals card links to the dedicated /schedule/requests page, which is
  // reachable by any approver (including schedule.manage_requests holders who are
  // not builders), so this no longer intersects with builder-openable departments
  // -- doing so previously hid a manage_requests holder's approvals entirely.
  const departmentIds = await manageableRequestDepartmentIds(personId);
  if (departmentIds.length === 0) return 0;

  // Span the working set, not just the live term. createRequest lets a member
  // raise a drop/swap against a published NEXT (PLANNING) term, so pinning the
  // count to the ACTIVE term hid those from the dashboard badge while the cron
  // kept emailing approvers about them. ARCHIVED-term requests are excluded: they
  // can no longer be decided anywhere. This matches the widened /schedule/requests
  // page. (The manageable-department set is still live-term-derived, so a
  // brand-new director who exists ONLY next term is not yet counted; that needs
  // threading the term through the shared scope helper and is left for later.)
  return prisma.shiftRequest.count({
    where: {
      departmentId: { in: departmentIds },
      status: "PENDING",
      term: { status: { in: ["ACTIVE", "PLANNING"] } },
    },
  });
}

async function scopeCheck(actorPersonId: string, departmentId: string): Promise<void> {
  if (!(await canManageRequestsForDept(actorPersonId, departmentId))) {
    throw new RequestForbiddenError();
  }
}

/**
 * The people who should be notified about a shift request for `departmentId`:
 * the department's ACTUAL approvers, derived from the same authority
 * approveRequest/denyRequest enforce (manageableRequestDepartmentIds), NOT merely
 * whoever holds a DIRECTOR shift on the calendar.
 *
 * Recipients =
 *   - department directors by membership + one-hop delegated directors
 *     ({@link departmentDirectorPersonIds}), PLUS
 *   - schedule.manage_requests holders who are ACTIVE members of the department
 *     (manageableRequestDepartmentIds only extends such a holder to departments
 *     they belong to).
 *
 * Blanket schedule.edit_all admins are intentionally excluded so a routine drop
 * request does not email every org-wide administrator. Deduped by person; the
 * caller no-ops any recipient without a contactEmail.
 *
 * Exported so the pending-request reminder cron
 * (src/app/api/cron/schedule-reminders/route.ts) reminds this same approver set
 * instead of re-deriving recipients from whoever holds a DIRECTOR shift.
 *
 * `termId` is the REQUEST's own term (not necessarily the active term), so a
 * next-term request routes to that term's directors, not the live term's.
 * Note: departmentDirectorPersonIds remains active-term-derived (a documented
 * cross-term deferral); only the ACTIVE-membership half below uses `termId`.
 */
export async function requestApproverRecipients(
  departmentId: string,
  termId: string,
): Promise<Array<{ id: string; name: string; contactEmail: string | null }>> {
  const [directorIds, memberships] = await Promise.all([
    departmentDirectorPersonIds(departmentId),
    prisma.termMembership.findMany({
      where: { termId, departmentId, status: "ACTIVE" },
      select: { personId: true },
    }),
  ]);

  const memberIds = [...new Set(memberships.map((m) => m.personId))];
  const manageRequestsMemberIds = (
    await Promise.all(
      memberIds.map(async (pid) =>
        (await can(pid, "schedule.manage_requests")) ? pid : null,
      ),
    )
  ).filter((pid): pid is string => pid !== null);

  const personIds = [...new Set([...directorIds, ...manageRequestsMemberIds])];
  if (personIds.length === 0) return [];

  return prisma.person.findMany({
    where: { id: { in: personIds } },
    select: { id: true, name: true, contactEmail: true },
  });
}

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

async function sendScheduleEmail(
  templateKey: string,
  to: string | null | undefined,
  personId: string,
  triggeredById: string,
  vars: Record<string, string>,
): Promise<void> {
  if (!to) return;
  try {
    // Supply the hub link vars from the configured base URL (every other email
    // builds links this way), so the schedule templates' {{ scheduleUrl }} /
    // {{ requestsUrl }} resolve to the deployed host instead of a hardcoded one.
    const baseUrl = (await getSetting<string>("app.baseUrl")).replace(/\/+$/, "");
    const withUrls = {
      scheduleUrl: `${baseUrl}/schedule`,
      requestsUrl: `${baseUrl}/schedule/requests`,
      ...vars,
    };
    // Route through the shared renderEmail path so schedule lifecycle emails get
    // the branded layout AND honor any admin EmailTemplate override, instead of
    // shipping the bare code-default fragment.
    const { subject, html } = await renderEmail(templateKey, withUrls);
    await queueEmail(prisma, {
      to,
      subject,
      html,
      template: templateKey,
      personId,
      triggeredById,
    });
  } catch {
    // Best-effort: never block the domain mutation on email failure.
  }
}

function fmtEmailDate(d: Date): string {
  return formatCalendarDate(d, { month: "long", day: "numeric", year: "numeric" });
}

// ---------------------------------------------------------------------------
// createRequest
// ---------------------------------------------------------------------------

export async function createRequest(
  actorPersonId: string,
  input: {
    termId: string;
    requesterDateKey: string;
    departmentId: string;
    targetId?: string;
    targetDateKey?: string;
    note?: string;
  },
): Promise<ShiftRequest> {
  const terms = await getPersonTerms(actorPersonId);
  const term = terms.find((t) => t.id === input.termId);
  if (!term) {
    throw new RequestValidationError("You are not on that term's roster.");
  }
  // Next-term requests are only valid once the department is published (defense
  // in depth: a member can only see a published next-term assignment to request
  // on in the first place).
  if (term.status !== "ACTIVE" && !(await isPublished(term.id, input.departmentId))) {
    throw new RequestValidationError("That schedule is not published.");
  }

  const clinicDateMap = new Map<string, Date>();
  for (const d of term.clinicDates) {
    clinicDateMap.set(isoDateKey(d), d);
  }

  const canonicalRequesterDate = clinicDateMap.get(input.requesterDateKey);
  if (!canonicalRequesterDate) {
    throw new RequestValidationError(
      `${input.requesterDateKey} is not a clinic date for this term.`,
    );
  }

  let canonicalTargetDate: Date | null = null;
  if (input.targetDateKey !== undefined) {
    const d = clinicDateMap.get(input.targetDateKey);
    if (!d) {
      throw new RequestValidationError(
        `${input.targetDateKey} is not a clinic date for this term.`,
      );
    }
    canonicalTargetDate = d;
  }

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
    if (isUniqueConstraintError(err)) {
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

  try {
    const [requester, department] = await Promise.all([
      prisma.person.findUnique({
        where: { id: actorPersonId },
        select: { name: true, contactEmail: true },
      }),
      prisma.department.findUnique({
        where: { id: input.departmentId },
        select: { name: true },
      }),
    ]);

    const requesterFirstName = requester?.name?.split(" ")[0] ?? requester?.name ?? "";
    const deptName = department?.name ?? "";
    const requesterDateStr = fmtEmailDate(canonicalRequesterDate);

    let partner: { name: string; contactEmail: string | null } | null = null;
    let partnerDateStr = "";

    if (isSwap && input.targetId && canonicalTargetDate) {
      partner = await prisma.person.findUnique({
        where: { id: input.targetId },
        select: { name: true, contactEmail: true },
      });
      partnerDateStr = fmtEmailDate(canonicalTargetDate);
      const partnerFirstName = partner?.name?.split(" ")[0] ?? partner?.name ?? "";

      await Promise.all([
        sendScheduleEmail(
          "schedule-swap-submitted-requester",
          requester?.contactEmail,
          actorPersonId,
          actorPersonId,
          {
            requesterName: requesterFirstName,
            partnerName: partner?.name ?? "",
            requesterDate: requesterDateStr,
            partnerDate: partnerDateStr,
            departmentName: deptName,
          },
        ),
        sendScheduleEmail(
          "schedule-swap-submitted-partner",
          partner?.contactEmail,
          input.targetId,
          actorPersonId,
          {
            partnerName: partnerFirstName,
            requesterName: requester?.name ?? "",
            requesterDate: requesterDateStr,
            partnerDate: partnerDateStr,
            departmentName: deptName,
          },
        ),
      ]);
    } else {
      await sendScheduleEmail(
        "schedule-drop-submitted-requester",
        requester?.contactEmail,
        actorPersonId,
        actorPersonId,
        {
          requesterName: requesterFirstName,
          requesterDate: requesterDateStr,
          departmentName: deptName,
        },
      );
    }

    // Notify the department's actual approvers (directors by membership, one-hop
    // delegated directors, and schedule.manage_requests holders in the
    // department), the same authority approveRequest enforces -- not merely
    // whoever happens to hold a DIRECTOR shift on the calendar.
    const approvers = await requestApproverRecipients(input.departmentId, term.id);

    await Promise.all(
      approvers.map((approver) =>
        sendScheduleEmail(
          "schedule-request-submitted-director",
          approver.contactEmail,
          approver.id,
          actorPersonId,
          {
            directorName: approver.name?.split(" ")[0] ?? approver.name ?? "",
            requesterName: requester?.name ?? "",
            requestType: isSwap ? "swap" : "drop",
            requesterDate: requesterDateStr,
            partnerName: partner?.name ?? "",
            partnerDate: partnerDateStr,
            departmentName: deptName,
          },
        )
      )
    );
  } catch {
    // Best-effort notifications.
  }

  return created;
}

// ---------------------------------------------------------------------------
// cancelRequest
// ---------------------------------------------------------------------------

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

  // Atomic guarded transition: the read-time check above gives the friendly
  // message for the common case; this precondition closes the race window so a
  // request already approved/denied by a director cannot also be flipped to
  // CANCELLED.
  const { count } = await prisma.shiftRequest.updateMany({
    where: { id: requestId, status: "PENDING" },
    data: { status: "CANCELLED" },
  });
  if (count === 0) {
    throw new RequestValidationError("This request was already decided.");
  }

  await recordAudit({
    actorPersonId,
    action: "schedule.request_cancel",
    entityType: "ShiftRequest",
    entityId: requestId,
  });

  try {
    if (req.targetId && req.targetDate) {
      const [requester, partner, department] = await Promise.all([
        prisma.person.findUnique({
          where: { id: req.requesterId },
          select: { name: true },
        }),
        prisma.person.findUnique({
          where: { id: req.targetId },
          select: { name: true, contactEmail: true },
        }),
        prisma.department.findUnique({
          where: { id: req.departmentId },
          select: { name: true },
        }),
      ]);
      await sendScheduleEmail(
        "schedule-request-cancelled-partner",
        partner?.contactEmail,
        req.targetId,
        actorPersonId,
        {
          partnerName: partner?.name?.split(" ")[0] ?? "",
          requesterName: requester?.name ?? "",
          partnerDate: fmtEmailDate(req.targetDate),
          departmentName: department?.name ?? "",
        },
      );
    }
  } catch {
    // Best-effort notifications.
  }
}

// ---------------------------------------------------------------------------
// listDepartmentRequests
// ---------------------------------------------------------------------------

export async function listDepartmentRequests(
  viewerPersonId: string,
  departmentId: string,
  termId: string,
): Promise<RequestRow[]> {
  await scopeCheck(viewerPersonId, departmentId);

  const term = await prisma.term.findUnique({ where: { id: termId } });
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
        status: { in: ["APPROVED", "DENIED", "CANCELLED"] },
      },
      include: {
        requester: { select: { name: true } },
        target: { select: { name: true } },
        decidedBy: { select: { name: true } },
      },
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

  const mutations = planApply({
    scheduleRows,
    requesterId: req.requesterId,
    requesterDate: requesterDateKey,
    targetId: req.targetId ?? undefined,
    targetDate: targetDateKey,
  });

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

    // Re-assert that anyone being ASSIGNED here is still ACTIVE (audit F5).
    // validateRequest / the swap-partner list are derived purely from
    // ShiftAssignment rows, which outlive an offboarded person, so without this an
    // offboarded volunteer with a leftover future assignment could be swapped onto
    // a shift. Only "add" ops need the check ("remove" of an offboarded person is
    // desirable).
    const addPersonIds = [...new Set(mutations.filter((m) => m.op !== "remove").map((m) => m.personId))];
    if (addPersonIds.length > 0) {
      // Require an ACTIVE TermMembership in THIS department/term, not merely
      // Person.status === "ACTIVE". A single-department offboard or roster removal
      // sets TermMembership.status = "REMOVED" while leaving Person.status ACTIVE
      // and does not delete leftover ShiftAssignment rows, so a globally-active
      // person who is no longer in this department must not be swapped back onto
      // its shifts. Mirrors the (person, department) active-membership check used
      // by setAssignment (builder.ts) and the shift-reminders cron.
      const activeMembers = await tx.termMembership.findMany({
        where: { termId: req.termId, departmentId: req.departmentId, personId: { in: addPersonIds }, status: "ACTIVE" },
        select: { personId: true },
      });
      const activeSet = new Set(activeMembers.map((m) => m.personId));
      if (addPersonIds.some((id) => !activeSet.has(id))) {
        throw new RequestValidationError(
          "A participant is no longer an active member of this department and can no longer be scheduled.",
        );
      }
    }

    // Capture each moved person's existing role tags BEFORE any delete, so a swap
    // carries triage/walk-in/cc/remote onto the person's new date instead of
    // silently resetting them to defaults. Each person is removed from exactly one
    // date per plan, so keying by personId is unambiguous.
    const tagsByPerson = new Map<
      string,
      { triage: boolean; walkin: boolean; cc: boolean; remote: boolean }
    >();
    for (const mutation of mutations) {
      if (mutation.op !== "remove") continue;
      const canonicalDate = clinicDateMap.get(mutation.dateKey);
      if (!canonicalDate) continue;
      const existing = await tx.shiftAssignment.findUnique({
        where: {
          termId_departmentId_clinicDate_personId: {
            termId: req.termId,
            departmentId: req.departmentId,
            clinicDate: canonicalDate,
            personId: mutation.personId,
          },
        },
        select: { triage: true, walkin: true, cc: true, remote: true },
      });
      if (existing) tagsByPerson.set(mutation.personId, existing);
    }

    for (const mutation of mutations) {
      const dbRole = mutation.role.toUpperCase() as "DIRECTOR" | "VOLUNTEER" | "SHADOW";

      const canonicalDate = clinicDateMap.get(mutation.dateKey);
      if (!canonicalDate) {
        throw new RequestValidationError(
          `Clinic date ${mutation.dateKey} no longer exists in the term.`,
        );
      }

      if (mutation.op === "remove") {
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
        const carriedTags = tagsByPerson.get(mutation.personId) ?? {};
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
            ...carriedTags,
          },
          update: { role: dbRole, ...carriedTags },
        });
      }
    }

    // Atomic status flip: only a still-PENDING request becomes APPROVED. If a
    // concurrent deny/cancel decided it first, count === 0 and the whole
    // transaction rolls back, so applied mutations can never coexist with a
    // DENIED/CANCELLED status.
    const { count } = await tx.shiftRequest.updateMany({
      where: { id: requestId, status: "PENDING" },
      data: {
        status: "APPROVED",
        decidedById: actorPersonId,
        decidedAt: now,
      },
    });
    if (count === 0) {
      throw new RequestValidationError("This request was already decided.");
    }
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

  try {
    const isSwap = !!(req.targetId && req.targetDate);
    const [requester, department] = await Promise.all([
      prisma.person.findUnique({
        where: { id: req.requesterId },
        select: { name: true, contactEmail: true },
      }),
      prisma.department.findUnique({
        where: { id: req.departmentId },
        select: { name: true },
      }),
    ]);

    const requesterFirstName = requester?.name?.split(" ")[0] ?? "";
    const deptName = department?.name ?? "";
    const requesterDateStr = fmtEmailDate(req.requesterDate);

    await sendScheduleEmail(
      "schedule-request-approved",
      requester?.contactEmail,
      req.requesterId,
      actorPersonId,
      {
        recipientName: requesterFirstName,
        requestType: isSwap ? "swap" : "drop",
        requesterDate: requesterDateStr,
        partnerDate: req.targetDate ? fmtEmailDate(req.targetDate) : "",
        departmentName: deptName,
      },
    );

    if (isSwap && req.targetId && req.targetDate) {
      const partner = await prisma.person.findUnique({
        where: { id: req.targetId },
        select: { name: true, contactEmail: true },
      });
      await sendScheduleEmail(
        "schedule-request-approved-partner",
        partner?.contactEmail,
        req.targetId,
        actorPersonId,
        {
          partnerName: partner?.name?.split(" ")[0] ?? "",
          requesterDate: requesterDateStr,
          partnerDate: fmtEmailDate(req.targetDate),
          departmentName: deptName,
        },
      );
    }
  } catch {
    // Best-effort notifications.
  }
}

// ---------------------------------------------------------------------------
// denyRequest
// ---------------------------------------------------------------------------

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

  // Atomic guarded transition: the read-time check above covers the common case;
  // this precondition closes the race window so an applied approval cannot also
  // be flipped to DENIED (which would leave mutations applied under a DENIED
  // status).
  const { count } = await prisma.shiftRequest.updateMany({
    where: { id: requestId, status: "PENDING" },
    data: {
      status: "DENIED",
      decidedById: actorPersonId,
      decidedAt: now,
      note: newNote,
    },
  });
  if (count === 0) {
    throw new RequestValidationError("This request was already decided.");
  }

  await recordAudit({
    actorPersonId,
    action: "schedule.request_deny",
    entityType: "ShiftRequest",
    entityId: requestId,
    after: { note: newNote },
  });

  try {
    const isSwap = !!(req.targetId && req.targetDate);
    const [requester, department] = await Promise.all([
      prisma.person.findUnique({
        where: { id: req.requesterId },
        select: { name: true, contactEmail: true },
      }),
      prisma.department.findUnique({
        where: { id: req.departmentId },
        select: { name: true },
      }),
    ]);
    await sendScheduleEmail(
      "schedule-request-denied",
      requester?.contactEmail,
      req.requesterId,
      actorPersonId,
      {
        requesterName: requester?.name?.split(" ")[0] ?? "",
        requestType: isSwap ? "swap" : "drop",
        requesterDate: fmtEmailDate(req.requesterDate),
        departmentName: department?.name ?? "",
      },
    );

    if (isSwap && req.targetId && req.targetDate) {
      const partner = await prisma.person.findUnique({
        where: { id: req.targetId },
        select: { name: true, contactEmail: true },
      });
      await sendScheduleEmail(
        "schedule-request-denied-partner",
        partner?.contactEmail,
        req.targetId,
        actorPersonId,
        {
          partnerName: partner?.name?.split(" ")[0] ?? "",
          requesterName: requester?.name ?? "",
          requesterDate: fmtEmailDate(req.requesterDate),
          partnerDate: fmtEmailDate(req.targetDate),
          departmentName: department?.name ?? "",
        },
      );
    }
  } catch {
    // Best-effort notifications.
  }
}

// ---------------------------------------------------------------------------
// eligibleSwapPartners
// ---------------------------------------------------------------------------

export async function eligibleSwapPartners(
  actorPersonId: string,
  requesterDateKey: string,
  departmentId: string,
  termId: string,
): Promise<Array<{ personId: string; name: string; dateKey: string }>> {
  const term = await prisma.term.findUnique({ where: { id: termId } });
  if (!term) return [];

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
  if (actorAssignment.role === "SHADOW") return [];

  const actorRole = actorAssignment.role;
  const requesterDates = term.clinicDates.filter((d) => isoDateKey(d) === requesterDateKey);

  const [partners, actorAssignments, othersOnRequesterDate, activeMemberships] = await Promise.all([
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
    prisma.shiftAssignment.findMany({
      where: { termId: term.id, departmentId, personId: actorPersonId },
      select: { clinicDate: true },
    }),
    prisma.shiftAssignment.findMany({
      where: {
        termId: term.id,
        departmentId,
        personId: { not: actorPersonId },
        clinicDate: { in: requesterDates },
      },
      select: { personId: true },
    }),
    // Everyone still an ACTIVE member of THIS department this term. A leftover
    // ShiftAssignment survives a single-department removal (which leaves
    // Person.status ACTIVE), so membership -- not Person.status -- is the gate.
    prisma.termMembership.findMany({
      where: { termId: term.id, departmentId, status: "ACTIVE" },
      select: { personId: true },
    }),
  ]);

  const actorBusyDateKeys = new Set(actorAssignments.map((a) => isoDateKey(a.clinicDate)));
  const partnerIdsOnRequesterDate = new Set(othersOnRequesterDate.map((a) => a.personId));
  const activeMemberIds = new Set(activeMemberships.map((m) => m.personId));

  return partners
    .filter(
      (p) =>
        // Partners are read from ShiftAssignment rows, which outlive a removed
        // membership, so a person no longer in this department (single-dept
        // offboard / roster removal, both of which leave Person.status ACTIVE)
        // with a leftover future shift would otherwise be offered and, once
        // approved, re-scheduled. Gate on active membership, not Person.status;
        // approveRequest re-checks this on the write path.
        activeMemberIds.has(p.personId) &&
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

// ---------------------------------------------------------------------------
// remindDirectors
// ---------------------------------------------------------------------------

/** The director-notification template, reused for the manual reminder. */
const REMINDER_TEMPLATE = "schedule-request-submitted-director";
/** An approver notified with REMINDER_TEMPLATE within this window is skipped, so
 *  repeated manual reminders can't flood directors (mirrors the cron throttle). */
const REMINDER_THROTTLE_MS = 3 * 24 * 60 * 60 * 1000;

/**
 * Re-sends the director notification for a PENDING shift request.
 * Only callable by the requester. Only allowed if the request has been
 * pending for more than 5 calendar days.
 *
 * Per-approver throttled (REMINDER_THROTTLE_MS): an approver who already received
 * this template recently is skipped, so a requester clicking "Remind" repeatedly
 * cannot flood every director (audit F15).
 */
export async function remindDirectors(
  actorPersonId: string,
  requestId: string,
): Promise<void> {
  const req = await prisma.shiftRequest.findUnique({
    where: { id: requestId },
    include: {
      requester: { select: { name: true } },
      target: { select: { name: true } },
      department: { select: { id: true, name: true } },
      term: { select: { id: true } },
    },
  });

  if (!req) throw new RequestNotFoundError();
  if (req.requesterId !== actorPersonId) throw new RequestForbiddenError("Only the requester can send a reminder.");
  if (req.status !== "PENDING") throw new RequestValidationError("Only pending requests can send reminders.");

  const daysSince = Math.floor((Date.now() - req.createdAt.getTime()) / (1000 * 60 * 60 * 24));
  if (daysSince < 5) throw new RequestValidationError("You can only send a reminder after 5 days.");

  const isSwap = !!(req.targetId && req.targetDate);
  const requesterDateStr = fmtEmailDate(req.requesterDate);
  const partnerDateStr = req.targetDate ? fmtEmailDate(req.targetDate) : "";

  // Same approver set as the initial notification: directors by membership,
  // one-hop delegated directors, and in-department schedule.manage_requests
  // holders -- the people who can actually decide this request.
  const approvers = await requestApproverRecipients(req.departmentId, req.termId);
  const throttleCutoff = new Date(Date.now() - REMINDER_THROTTLE_MS);

  await Promise.all(
    approvers.map(async (approver) => {
      if (!approver.contactEmail) return;
      // Throttle: skip an approver already notified with this template inside the
      // window (a prior reminder or the original submission notice), so repeated
      // clicks are a no-op rather than an email flood (audit F15).
      const already = await prisma.emailLog.findFirst({
        where: { personId: approver.id, template: REMINDER_TEMPLATE, createdAt: { gte: throttleCutoff } },
        select: { id: true },
      });
      if (already) return;
      // Shared render path: branded layout + admin override, not a bare fragment.
      const { subject, html } = await renderEmail(REMINDER_TEMPLATE, {
        directorName: approver.name?.split(" ")[0] ?? approver.name ?? "",
        requesterName: req.requester.name,
        requestType: isSwap ? "swap" : "drop",
        requesterDate: requesterDateStr,
        partnerName: req.target?.name ?? "",
        partnerDate: partnerDateStr,
        departmentName: req.department.name,
      });
      await queueEmail(prisma, {
        to: approver.contactEmail,
        subject,
        html,
        template: REMINDER_TEMPLATE,
        personId: approver.id,
        triggeredById: actorPersonId,
      });
    })
  );
}
