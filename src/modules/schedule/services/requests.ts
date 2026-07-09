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
import { isoDateKey } from "@/platform/dates";
import { manageableDepartmentIds, memberDepartmentIds } from "@/platform/departments";
import { can } from "@/platform/rbac/engine";
import {
  validateRequest,
  planApply,
} from "../engine/requests";
import type { ScheduleRowForValidation } from "../engine/requests";
import { getActiveTerm } from "@/platform/terms/active-term";
import { queueEmail } from "@/platform/email/send";
import { renderTemplate } from "@/platform/email/render/render";
import { getDescriptor } from "@/platform/email/templates/registry";

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

async function scopeCheck(actorPersonId: string, departmentId: string): Promise<void> {
  if (!(await canManageRequestsForDept(actorPersonId, departmentId))) {
    throw new RequestForbiddenError();
  }
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
  const descriptor = getDescriptor(templateKey);
  if (!descriptor) return;
  try {
    const subject = renderTemplate(descriptor.defaultSubject, vars);
    const html = renderTemplate(descriptor.defaultBody, vars);
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
  return d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
}

// ---------------------------------------------------------------------------
// createRequest
// ---------------------------------------------------------------------------

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

    // Notify all active directors of the department.
    const activeTerm2 = await getActiveTerm();
    if (activeTerm2) {
      const directorAssignments = await prisma.shiftAssignment.findMany({
        where: {
          termId: activeTerm2.id,
          departmentId: input.departmentId,
          role: "DIRECTOR",
        },
        select: {
          person: { select: { name: true, contactEmail: true, id: true } },
        },
      });

      const uniqueDirectors = new Map(
        directorAssignments.map((a) => [a.person.id, a.person])
      );

      await Promise.all(
        [...uniqueDirectors.values()].map((director) =>
          sendScheduleEmail(
            "schedule-request-submitted-director",
            director.contactEmail,
            director.id,
            actorPersonId,
            {
              directorName: director.name?.split(" ")[0] ?? director.name ?? "",
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
    }
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
): Promise<Array<{ personId: string; name: string; dateKey: string }>> {
  const term = await getActiveTerm();
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

  const [partners, actorAssignments, othersOnRequesterDate] = await Promise.all([
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
  ]);

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

// ---------------------------------------------------------------------------
// remindDirectors
// ---------------------------------------------------------------------------

/**
 * Re-sends the director notification for a PENDING shift request.
 * Only callable by the requester. Only allowed if the request has been
 * pending for more than 5 calendar days.
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

  const descriptor = getDescriptor("schedule-request-submitted-director");
  if (!descriptor) return;

  const isSwap = !!(req.targetId && req.targetDate);
  const requesterDateStr = req.requesterDate.toLocaleDateString("en-US", {
    month: "long", day: "numeric", year: "numeric",
  });
  const partnerDateStr = req.targetDate
    ? req.targetDate.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })
    : "";

  const directorAssignments = await prisma.shiftAssignment.findMany({
    where: {
      termId: req.termId,
      departmentId: req.departmentId,
      role: "DIRECTOR",
    },
    select: {
      person: { select: { id: true, name: true, contactEmail: true } },
    },
  });

  const uniqueDirectors = new Map(
    directorAssignments.map((a) => [a.person.id, a.person])
  );

  await Promise.all(
    [...uniqueDirectors.values()].map(async (director) => {
      if (!director.contactEmail) return;
      const subject = renderTemplate(
        `Reminder: pending shift request from ${req.requester.name} - HAVEN`,
        {},
      );
      const html = renderTemplate(descriptor.defaultBody, {
        directorName: director.name?.split(" ")[0] ?? director.name ?? "",
        requesterName: req.requester.name,
        requestType: isSwap ? "swap" : "drop",
        requesterDate: requesterDateStr,
        partnerName: req.target?.name ?? "",
        partnerDate: partnerDateStr,
        departmentName: req.department.name,
      });
      await queueEmail(prisma, {
        to: director.contactEmail,
        subject,
        html,
        template: "schedule-request-submitted-director",
        personId: director.id,
        triggeredById: actorPersonId,
      });
    })
  );
}