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
import { can, getEffectivePermissions, hasPermission } from "@/platform/rbac/engine";

export const MANAGE = "support.manage_requests";
/**
 * Read-only counterpart to MANAGE: opens the cross-clinic ticket views to an
 * auditor who should see where every request stands without being able to move
 * one. It widens READ paths only -- listAllRequests and getTechRequest below --
 * and is deliberately absent from every write path, which keeps gating on
 * MANAGE via isManager. Comment threads and attachments stay manager-only too,
 * so a ticket's correspondence and files are not part of this grant.
 */
export const VIEW_ALL = "support.view_all_requests";
export const PAGE_SIZE = 25;

/**
 * Every TechRequest scalar, named explicitly.
 *
 * Used wherever a query needs the whole row, in place of letting Prisma imply
 * the column list. Prisma builds that list from `schema.prisma`, not from what
 * the calling code touches, so a query with no projection (and an `include:`,
 * which only names relations) emits every declared column. During a Vercel
 * build the previous deployment keeps serving while `prisma migrate deploy` has
 * already run, so the moment a column is dropped those queries ask for a column
 * the database no longer has and return 42703 to every caller. That is exactly
 * what commit 2ce40c15 did to `/support/[id]` and to the Intercom
 * ticket.created webhook.
 *
 * Listing all scalars keeps the result assignable to `TechRequest`, so this is
 * a pure hardening with no type churn at the call sites, and it makes the next
 * narrowing of this table fail loudly in `tsc` here instead of quietly in
 * production. See docs/DEPLOY.md §1 for the measurements.
 */
const TICKET_SCALARS = {
  id: true,
  number: true,
  airtableRecordId: true,
  requesterId: true,
  category: true,
  epicSubtype: true,
  subject: true,
  description: true,
  priority: true,
  status: true,
  assignedToId: true,
  resolution: true,
  resolvedAt: true,
  intercomConversationId: true,
  intercomTicketId: true,
  createdAt: true,
  updatedAt: true,
} as const;

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

/**
 * May this person read tickets they do not own? True for a manager and for a
 * VIEW_ALL auditor. Resolves the permission set once rather than calling `can`
 * twice, because both read paths below ask this on every request.
 *
 * Never use this to authorize a mutation: an auditor passes it. Write paths ask
 * isManager.
 */
export async function canViewAllRequests(personId: string): Promise<boolean> {
  const perms = await getEffectivePermissions(personId);
  return hasPermission(perms, MANAGE) || hasPermission(perms, VIEW_ALL);
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
};

/**
 * Creates a TechRequest owned by the caller.
 *
 * subject and description must be non-blank (SupportStateError). An EPIC
 * ticket may be created with epicSubtype null: the request kind is chosen by
 * a manager at promotion time, not by the submitter.
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
 * returned with `created: false`. Returned unchanged EXCEPT for the one
 * back-fill this path owns: a ticket found by its conversation id that has no
 * intercomTicketId yet gains one (see linkIntercomTicketId).
 *
 * The lookup-then-create pair still leaves a race window between two
 * genuinely concurrent calls for the same conversation/ticket (both can pass
 * the lookup before either commits), so the create is wrapped in a catch for
 * the P2002 that then lands on one of the two unique indexes: the loser
 * re-reads and returns the winner's row instead of surfacing a raw
 * constraint violation as a 500.
 *
 * Deliberately narrow compared to CreateTechRequestInput: category, subject,
 * and description only. epicSubtype is not an accepted parameter here at
 * all, so one riding along in an HTTP body has nothing to bind to --
 * structurally unable to be persisted, not merely unused. EPIC remains an
 * accepted category so the ticket still routes correctly; a manager chooses
 * the request kind later, at promotion time, exactly as createTechRequest's
 * own doc comment describes for a Hub-form submission.
 *
 * requesterPersonId is a parameter, never resolved here: the caller must
 * already have it from resolveIdentityFromConversation. A forged requester
 * would file a ticket as somebody else, and that check belongs where the
 * request enters the system, not buried in this function's body.
 *
 * `linked` in the result reports that an EXISTING ticket just gained its
 * intercomTicketId (see linkIntercomTicketId below). It is a third outcome, not
 * a flavour of `created`: nothing is created, but the caller now has a first
 * chance to do the ticket-id-only work it could not do before -- which is why
 * the webhook route pushes the Hub ticket number back on it.
 */
export async function createTechRequestFromConversation(
  requesterPersonId: string,
  input: CreateFromConversationInput
): Promise<{ ticket: TechRequest; created: boolean; linked: boolean }> {
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
        select: TICKET_SCALARS,
      })
    : await prisma.techRequest.findUnique({
        where: { intercomConversationId: input.intercomConversationId },
        select: TICKET_SCALARS,
      });
  if (existing) {
    const { ticket, linked } = await linkIntercomTicketId(existing, input.intercomTicketId);
    return { ticket, created: false, linked };
  }

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
      select: TICKET_SCALARS,
    });

    await recordAudit({
      actorPersonId: requesterPersonId,
      action: "support.request_create",
      entityType: "TechRequest",
      entityId: ticket.id,
      after: { category: ticket.category, number: ticket.number, source: "intercom" },
    });

    return { ticket, created: true, linked: false };
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
            select: TICKET_SCALARS,
          })
        : await prisma.techRequest.findUnique({
            where: { intercomConversationId: input.intercomConversationId },
            select: TICKET_SCALARS,
          });
      if (winner) {
        const { ticket, linked } = await linkIntercomTicketId(winner, input.intercomTicketId);
        return { ticket, created: false, linked };
      }
    }
    throw err;
  }
}

/**
 * Back-fills intercomTicketId onto a ticket that already exists for this
 * conversation but has never been linked to an Intercom Ticket. Returns the
 * ticket unchanged (linked: false) when there is nothing to do.
 *
 * This is the repair for the sync link ticket.created used to sever silently
 * (audit 14, SUP-1/INT-1). A ticket created by Fin's custom action
 * (src/app/api/support/tickets/from-conversation) only ever has a conversation
 * id, because no Intercom Ticket exists at that moment. When Intercom later
 * converts that conversation into a Ticket, ticket.created fires with the SAME
 * id -- and this function used to find the existing row and return early, never
 * writing the ticket id. Nothing else in the codebase ever wrote that column,
 * so the link was severed permanently and invisibly: every inbound status path
 * keys on intercomTicketId (applyIntercomTicketStateChange's findUnique), and
 * the reconciliation sweep filters on `intercomTicketId: { not: null }`, so the
 * backstop built to catch a missed sync could not see the ticket either. The
 * ticket simply stopped receiving Intercom state changes forever, with no error
 * anywhere.
 *
 * A P2002 here means a DIFFERENT row already holds this ticket id -- two
 * conversations that Intercom merged into one Ticket, which no write can
 * reconcile. Left unlinked and audited rather than thrown: the ticket the
 * caller asked about still exists and is still correct, and failing the webhook
 * over it would only make Intercom retry a conflict that cannot resolve.
 */
async function linkIntercomTicketId(
  existing: TechRequest,
  intercomTicketId: string | undefined
): Promise<{ ticket: TechRequest; linked: boolean }> {
  if (!intercomTicketId || existing.intercomTicketId) return { ticket: existing, linked: false };

  try {
    const ticket = await prisma.techRequest.update({
      where: { id: existing.id },
      data: { intercomTicketId },
      select: TICKET_SCALARS,
    });

    await recordAudit({
      actorPersonId: null,
      action: "support.intercom_ticket_link",
      entityType: "TechRequest",
      entityId: existing.id,
      before: { intercomTicketId: null },
      after: { intercomTicketId, number: existing.number, source: "intercom" },
    });

    return { ticket, linked: true };
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      await recordAudit({
        actorPersonId: null,
        action: "support.intercom_ticket_link_conflict",
        entityType: "TechRequest",
        entityId: existing.id,
        after: { intercomTicketId, number: existing.number },
      });
      return { ticket: existing, linked: false };
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
  // Needed so the list views can offer the right Intercom affordance per row
  // (continue in the Messenger, or deep-link into the agent inbox) without a
  // second query -- see RequestList's intercomAction prop.
  intercomConversationId: true,
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
  intercomConversationId: string | null;
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
 * support.manage_requests or support.view_all_requests (SupportForbiddenError
 * otherwise) -- the list itself is identical for both; only the actions a
 * caller can then take on a row differ.
 *
 * counts is a groupBy across ALL statuses regardless of the applied filter.
 */
export async function listAllRequests(
  actorPersonId: string,
  filter: RequestFilter
): Promise<{ rows: TechRequestListRow[]; total: number; counts: Record<TechRequestStatus, number> }> {
  if (!(await canViewAllRequests(actorPersonId))) {
    throw new SupportForbiddenError(`The ${MANAGE} or ${VIEW_ALL} permission is required.`);
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

/**
 * Explicit `select:` on the scalars, deliberately, not `include:`.
 *
 * `include` names RELATIONS; it leaves the scalar list alone, so the generated
 * SQL still emits every column `schema.prisma` declares. That is what made this
 * query the casualty of commit 2ce40c15: `prisma migrate deploy` runs at the
 * start of the Vercel build while the PREVIOUS deployment still serves traffic,
 * so for the whole build window the old client asked for seven columns the
 * migration had just dropped, and `/support/[id]` returned 42703 to every
 * caller. Measured in audit 13: a no-projection query and an `include:`-only
 * query both fail that way; an explicit `select:` survives untouched.
 *
 * Keeping the projection explicit means the next narrowing of this table is a
 * non-event here. `tsc` enforces it: drop a field a caller reads and the build
 * fails at the call site rather than in production. See docs/DEPLOY.md §1.
 */
async function loadDetail(id: string) {
  return prisma.techRequest.findUnique({
    where: { id },
    select: {
      id: true,
      number: true,
      airtableRecordId: true,
      requesterId: true,
      category: true,
      epicSubtype: true,
      subject: true,
      description: true,
      priority: true,
      status: true,
      assignedToId: true,
      resolution: true,
      resolvedAt: true,
      intercomConversationId: true,
      intercomTicketId: true,
      createdAt: true,
      updatedAt: true,
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
 * Returns full ticket detail. The requester, a support.manage_requests holder,
 * or a support.view_all_requests auditor may read it; anyone else gets
 * SupportNotFoundError (not SupportForbiddenError) so a stranger cannot
 * distinguish "does not exist" from "exists but you can't see it".
 *
 * This returns the same payload to an auditor as to a manager, comments and
 * attachments included. Hiding those from an auditor is the PAGE's job (see
 * ticket-detail.tsx): a service that stripped them would also strip them from
 * the manager paths that share this loader.
 */
export async function getTechRequest(actorPersonId: string, id: string): Promise<TechRequestDetail> {
  const detail = await loadDetail(id);
  if (!detail) throw new SupportNotFoundError();
  const viewer = await canViewAllRequests(actorPersonId);
  if (!viewer && detail.requesterId !== actorPersonId) {
    // Do not leak existence to strangers.
    throw new SupportNotFoundError();
  }
  return detail;
}
