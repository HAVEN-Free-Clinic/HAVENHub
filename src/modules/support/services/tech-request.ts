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
 *
 *   TRUSTED callers (src/app/api/support/tickets/from-conversation and
 *   src/app/api/support/tickets/events -- the ticket.created webhook):
 *     createTechRequestFromConversation - requesterPersonId must already be a
 *                         verified identity (resolveIdentityFromConversation),
 *                         never a value taken from a request body. This
 *                         function does not itself verify anything; it trusts
 *                         its caller the same way createTechRequest trusts a
 *                         signed-in session.
 */

import type { TechRequest, TechRequestCategory, TechRequestStatus, EpicRequestKind } from "@prisma/client";
import { prisma, isUniqueConstraintError } from "@/platform/db";
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
/**
 * A SupportStateError raised specifically when a submission is blocked by an
 * existing OPEN Epic request for one or more people (a recoverable conflict, not
 * malformed input). Extends SupportStateError so existing
 * `instanceof SupportStateError` handlers still treat it as a state error, while
 * callers that want to distinguish "already exists" (and, e.g., keep the
 * generated artifacts rather than discard them) can catch this narrower type.
 */
export class SupportConflictError extends SupportStateError {
  /** Names of the people who already have an open Epic request. */
  readonly personNames: string[];
  constructor(message: string, personNames: string[]) {
    super(message);
    this.name = "SupportConflictError";
    this.personNames = personNames;
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
 * subject and description must be non-blank (SupportStateError). An EPIC
 * ticket may be created with epicSubtype null: the request kind is chosen by
 * a manager at promotion time, not by the submitter. Other epic-only fields
 * are only persisted for EPIC and are ignored otherwise.
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
// createTechRequestFromConversation
// ---------------------------------------------------------------------------

export type CreateFromConversationInput = {
  intercomConversationId: string;
  // Present only on the ticket.created webhook path (Direction 1's
  // 2026-08-12 revision): the from-conversation route (Fin's custom action)
  // never has a ticket id, since no Intercom Ticket exists at that point.
  // See the field's doc comment on the TechRequest model for why this is a
  // second, distinct column rather than folded into intercomConversationId.
  intercomTicketId?: string;
  category: TechRequestCategory;
  subject: string;
  description: string;
};

/**
 * Idempotent create for a ticket opened from an Intercom conversation, rather
 * than the Hub submit form. See docs/superpowers/specs/2026-08-12-intercom-ticket-sync-design.md.
 *
 * Two callers, two idempotency keys:
 *   - src/app/api/support/tickets/from-conversation/route.ts (Fin's custom
 *     action) has only a conversation id, and looks up/collides on
 *     intercomConversationId, exactly as before this function accepted a
 *     ticket id at all.
 *   - src/app/api/support/tickets/events/route.ts (the ticket.created
 *     webhook) has both a conversation id and a real Intercom ticket id, and
 *     that ticket id is the key Intercom repeats a retry on -- so when it is
 *     present, the lookup checks it (OR'd with the conversation id, so a
 *     conversation that already produced a ticket by the other path still
 *     collides correctly) rather than the conversation id alone.
 *
 * Either way this is deliberately not an error: an Intercom retry (of a
 * webhook delivery or of a Fin tool call) is normal, not a fault, and must
 * land on the SAME ticket, not a second one with a consecutive number --
 * returned unchanged, `created: false`.
 *
 * The lookup-then-create pair still leaves a race window between two
 * genuinely concurrent calls for the same conversation/ticket (both can pass
 * the lookup before either commits), so the create is wrapped in a catch for
 * the P2002 that then lands on one of the two unique indexes: the loser
 * re-reads and returns the winner's row instead of surfacing a raw
 * constraint violation as a 500.
 *
 * Deliberately narrow compared to CreateTechRequestInput: category, subject,
 * and description only. No Epic intake field (epicJobTitle, epicMirrorId,
 * epicStartDate, epicEndDate, worksAtYnhh, govId, netId) is an accepted
 * parameter here at all, so one riding along in an HTTP body has nothing to
 * bind to -- structurally unable to be persisted, not merely unused. EPIC
 * remains an accepted category so the ticket still routes correctly; a
 * manager fills in the Epic-specific fields later, from the Hub form, the
 * only place govId may ever be typed.
 *
 * requesterPersonId is a parameter, never resolved here: the caller must
 * already have it from resolveIdentityFromConversation. A forged requester
 * would file a ticket as somebody else, and that check belongs where the
 * request enters the system, not buried in this function's body.
 */
export async function createTechRequestFromConversation(
  requesterPersonId: string,
  input: CreateFromConversationInput
): Promise<{ ticket: TechRequest; created: boolean }> {
  // findUnique on intercomConversationId alone when there is no ticket id --
  // the exact query the from-conversation route has always run, left
  // untouched so that path's behavior (including what it looks like under a
  // database outage, covered by that route's own test) does not change.
  // findFirst-with-OR only kicks in for the ticket.created webhook path,
  // which is the one caller that ever has a ticket id to check.
  const existing = input.intercomTicketId
    ? await prisma.techRequest.findFirst({
        where: {
          OR: [{ intercomTicketId: input.intercomTicketId }, { intercomConversationId: input.intercomConversationId }],
        },
      })
    : await prisma.techRequest.findUnique({ where: { intercomConversationId: input.intercomConversationId } });
  if (existing) return { ticket: existing, created: false };

  const subject = input.subject?.trim();
  const description = input.description?.trim();
  if (!subject) throw new SupportStateError("A subject is required.");
  if (!description) throw new SupportStateError("A description is required.");

  try {
    const ticket = await prisma.techRequest.create({
      data: {
        requesterId: requesterPersonId,
        category: input.category,
        subject,
        description,
        status: "SUBMITTED",
        intercomConversationId: input.intercomConversationId,
        intercomTicketId: input.intercomTicketId ?? null,
      },
    });

    await recordAudit({
      actorPersonId: requesterPersonId,
      action: "support.request_create",
      entityType: "TechRequest",
      entityId: ticket.id,
      after: { category: ticket.category, number: ticket.number, source: "intercom" },
    });

    return { ticket, created: true };
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      // Another call for the same conversation/ticket won the race between
      // our lookup above and this create. Its row is exactly what we would
      // have returned had we lost the race the other way, so hand it back
      // rather than letting the constraint violation surface as a 500.
      const winner = input.intercomTicketId
        ? await prisma.techRequest.findFirst({
            where: {
              OR: [
                { intercomTicketId: input.intercomTicketId },
                { intercomConversationId: input.intercomConversationId },
              ],
            },
          })
        : await prisma.techRequest.findUnique({ where: { intercomConversationId: input.intercomConversationId } });
      if (winner) return { ticket: winner, created: false };
    }
    throw err;
  }
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
    // Only match on the ticket number when the digits fit a Postgres int4. A
    // longer digit string (e.g. an ID pasted into the search box) overflows the
    // `number` column and throws a raw error, so an out-of-range value simply
    // skips the numeric branch and matches on subject/requester only.
    const numMatch =
      Number.isFinite(asNum) && asNum >= 0 && asNum <= 2_147_483_647 ? [{ number: asNum }] : [];
    where.OR = [
      { subject: { contains: q, mode: "insensitive" } },
      { requester: { name: { contains: q, mode: "insensitive" } } },
      ...numMatch,
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
      requester: { select: { id: true, name: true, netId: true, contactEmail: true, epicId: true } },
      assignedTo: { select: { id: true, name: true } },
      epicRequests: {
        include: {
          ticket: true,
          person: { select: { id: true, name: true, epicId: true } },
        },
        orderBy: { createdAt: "asc" },
      },
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
