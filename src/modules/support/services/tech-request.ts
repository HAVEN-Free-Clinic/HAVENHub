/**
 * Support module TechRequest service core.
 *
 * Permission model:
 *   ENFORCED internally (call-site cannot bypass):
 *     listAllRequests - support.manage_requests
 *
 *   TRUSTED callers (page/server-action gates) with internal ownership checks:
 *     createTechRequest - any authenticated person (self-service submission)
 *     listMyRequests    - caller gates to the authenticated person
 *     getTechRequest    - requester or support.manage_requests holder; throws
 *                         SupportNotFoundError (not Forbidden) for anyone else
 *                         so a stranger cannot distinguish "not found" from
 *                         "exists but you can't see it".
 */

import type { TechRequest, TechRequestCategory, TechRequestStatus, EpicRequestKind } from "@prisma/client";
import { prisma } from "@/platform/db";
import { recordAudit } from "@/platform/audit";
import { can } from "@/platform/rbac/engine";

export const MANAGE = "support.manage_requests";
export const PAGE_SIZE = 25;

// ---------------------------------------------------------------------------
// Typed errors
// ---------------------------------------------------------------------------

export class SupportForbiddenError extends Error {
  constructor(message = "You do not have permission for this support action.") {
    super(message);
    this.name = "SupportForbiddenError";
  }
}
export class SupportNotFoundError extends Error {
  constructor(message = "Support request not found.") {
    super(message);
    this.name = "SupportNotFoundError";
  }
}
export class SupportStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SupportStateError";
  }
}

export async function isManager(personId: string): Promise<boolean> {
  return can(personId, MANAGE);
}

// ---------------------------------------------------------------------------
// createTechRequest
// ---------------------------------------------------------------------------

export type CreateTechRequestInput = {
  category: TechRequestCategory;
  subject: string;
  description: string;
  // EPIC-only; ignored for other categories.
  epicSubtype?: EpicRequestKind | null;
  epicJobTitle?: string | null;
  epicMirrorId?: string | null;
  epicStartDate?: Date | null;
  epicEndDate?: Date | null;
  worksAtYnhh?: boolean | null;
  govId?: string | null;
  netId?: string | null;
};

/**
 * Creates a TechRequest owned by the caller.
 *
 * subject and description must be non-blank (SupportStateError). For category
 * EPIC, epicSubtype must be one of NEW/MODIFY/RENEW (SupportStateError); other
 * epic-only fields are only persisted for EPIC and are ignored otherwise.
 *
 * Audits "support.request_create" with category and number in after.
 */
export async function createTechRequest(
  actorPersonId: string,
  input: CreateTechRequestInput
): Promise<TechRequest> {
  const subject = input.subject?.trim();
  const description = input.description?.trim();
  if (!subject) throw new SupportStateError("A subject is required.");
  if (!description) throw new SupportStateError("A description is required.");

  const isEpic = input.category === "EPIC";
  const epicSubtype = isEpic ? input.epicSubtype ?? null : null;
  if (isEpic && !(epicSubtype && ["NEW", "MODIFY", "RENEW"].includes(epicSubtype))) {
    throw new SupportStateError("Epic requests need a subtype of New, Modification, or Renewal.");
  }

  const req = await prisma.techRequest.create({
    data: {
      requesterId: actorPersonId,
      category: input.category,
      subject,
      description,
      status: "SUBMITTED",
      epicSubtype,
      epicJobTitle: isEpic ? input.epicJobTitle?.trim() || null : null,
      epicMirrorId: isEpic ? input.epicMirrorId?.trim() || null : null,
      epicStartDate: isEpic ? input.epicStartDate ?? null : null,
      epicEndDate: isEpic ? input.epicEndDate ?? null : null,
      worksAtYnhh: isEpic ? input.worksAtYnhh ?? null : null,
      govId: isEpic ? input.govId?.trim() || null : null,
      netId: isEpic ? input.netId?.trim() || null : null,
    },
  });

  await recordAudit({
    actorPersonId,
    action: "support.request_create",
    entityType: "TechRequest",
    entityId: req.id,
    after: { category: req.category, number: req.number },
  });

  return req;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

const LIST_SELECT = {
  id: true,
  number: true,
  category: true,
  epicSubtype: true,
  subject: true,
  priority: true,
  status: true,
  assignedToId: true,
  createdAt: true,
  updatedAt: true,
  requester: { select: { id: true, name: true } },
  assignedTo: { select: { id: true, name: true } },
} as const;

export type TechRequestListRow = {
  id: string;
  number: number;
  category: TechRequestCategory;
  epicSubtype: EpicRequestKind | null;
  subject: string;
  priority: TechRequest["priority"];
  status: TechRequestStatus;
  assignedToId: string | null;
  createdAt: Date;
  updatedAt: Date;
  requester: { id: string; name: string | null };
  assignedTo: { id: string; name: string | null } | null;
};

/** Returns the caller's own tickets, newest-updated first. Trusts callers: the page gates this to the authenticated person. */
export async function listMyRequests(personId: string): Promise<TechRequestListRow[]> {
  return prisma.techRequest.findMany({
    where: { requesterId: personId },
    orderBy: { updatedAt: "desc" },
    select: LIST_SELECT,
  }) as unknown as Promise<TechRequestListRow[]>;
}

export type RequestFilter = {
  status?: TechRequestStatus;
  category?: TechRequestCategory;
  priority?: TechRequest["priority"];
  assignedToId?: string;
  q?: string;
  page?: number;
};

/**
 * Returns a paginated, filtered master list of all tickets. Requires
 * support.manage_requests (SupportForbiddenError otherwise).
 *
 * counts is a groupBy across ALL statuses regardless of the applied filter.
 */
export async function listAllRequests(
  actorPersonId: string,
  filter: RequestFilter
): Promise<{ rows: TechRequestListRow[]; total: number; counts: Record<TechRequestStatus, number> }> {
  if (!(await can(actorPersonId, MANAGE))) {
    throw new SupportForbiddenError(`The ${MANAGE} permission is required.`);
  }
  const page = filter.page ?? 1;
  const where: Record<string, unknown> = {};
  if (filter.status) where.status = filter.status;
  if (filter.category) where.category = filter.category;
  if (filter.priority) where.priority = filter.priority;
  if (filter.assignedToId) where.assignedToId = filter.assignedToId;
  if (filter.q?.trim()) {
    const q = filter.q.trim();
    const asNum = Number.parseInt(q, 10);
    where.OR = [
      { subject: { contains: q, mode: "insensitive" } },
      { requester: { name: { contains: q, mode: "insensitive" } } },
      ...(Number.isFinite(asNum) ? [{ number: asNum }] : []),
    ];
  }
  const [rows, total, groupBy] = await Promise.all([
    prisma.techRequest.findMany({
      where,
      orderBy: { updatedAt: "desc" },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      select: LIST_SELECT,
    }),
    prisma.techRequest.count({ where }),
    prisma.techRequest.groupBy({ by: ["status"], _count: { _all: true } }),
  ]);
  const counts = {
    SUBMITTED: 0,
    IN_PROGRESS: 0,
    AWAITING_REQUESTER: 0,
    AWAITING_YNHH: 0,
    RESOLVED: 0,
    CLOSED: 0,
    CANCELLED: 0,
  } as Record<TechRequestStatus, number>;
  for (const g of groupBy) counts[g.status] = g._count._all;
  return { rows: rows as unknown as TechRequestListRow[], total, counts };
}

async function loadDetail(id: string) {
  return prisma.techRequest.findUnique({
    where: { id },
    include: {
      requester: { select: { id: true, name: true, netId: true, contactEmail: true } },
      assignedTo: { select: { id: true, name: true } },
      epicRequest: true,
      attachments: true,
    },
  });
}

export type TechRequestDetail = NonNullable<Awaited<ReturnType<typeof loadDetail>>>;

/**
 * Returns full ticket detail. The requester or a support.manage_requests
 * holder may read it; anyone else gets SupportNotFoundError (not
 * SupportForbiddenError) so a stranger cannot distinguish "does not exist"
 * from "exists but you can't see it".
 */
export async function getTechRequest(actorPersonId: string, id: string): Promise<TechRequestDetail> {
  const detail = await loadDetail(id);
  if (!detail) throw new SupportNotFoundError();
  const manager = await can(actorPersonId, MANAGE);
  if (!manager && detail.requesterId !== actorPersonId) {
    // Do not leak existence to strangers.
    throw new SupportNotFoundError();
  }
  return detail;
}
