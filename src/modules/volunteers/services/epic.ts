/**
 * Volunteers module epic request service.
 *
 * Permission model:
 *   ENFORCED internally (call-site cannot bypass):
 *     createEpicRequest      - self OR volunteers.manage_epic
 *     createTicket           - volunteers.manage_epic
 *     setTicketServiceRequestNumber - volunteers.manage_epic
 *     closeTicket            - volunteers.manage_epic
 *     completeRequest        - volunteers.manage_epic
 *     cancelRequest          - volunteers.manage_epic
 *     sendEpicEmail          - volunteers.manage_epic
 *     updateRequestDetails   - volunteers.manage_epic (manager-only)
 *
 *   TRUSTED callers (page/server-action gates):
 *     myEpicPanel        - caller gates to the authenticated person
 *     listEpicRequests   - caller gates to manage_epic holders
 *     listTickets        - caller gates to manage_epic holders
 *     emailHistory       - caller gates to manage_epic holders
 *
 * updatePersonFields (from @/platform/people) is used for all epicId writes:
 * it diffs, audits person.update, and enqueues the mirror outbox entry. Do not
 * duplicate that logic here.
 */

import type { EpicRequest, EmailLog, YnhhTicket } from "@prisma/client";
import type { EpicRequestKind, EpicRequestStatus } from "@prisma/client";
import { prisma } from "@/platform/db";
import { recordAudit } from "@/platform/audit";
import { can } from "@/platform/rbac/engine";
import { updatePersonFields, PersonNotFoundError } from "@/platform/people";
import { notify } from "@/platform/notifications/notify";
import { getSetting } from "@/platform/settings/service";
import {
  epicOnboardingContext,
  epicActivationContext,
  epicPasswordResetContext,
  type EpicEmailParams,
  type EpicTemplateKey,
} from "@/platform/email/templates/epic";
import { renderEmail } from "@/platform/email/templates/renderEmail";

const PAGE_SIZE = 25;

// ---------------------------------------------------------------------------
// Typed errors
// ---------------------------------------------------------------------------

export class EpicForbiddenError extends Error {
  constructor(message = "You do not have permission to perform this epic action.") {
    super(message);
    this.name = "EpicForbiddenError";
  }
}

export class EpicNotFoundError extends Error {
  constructor(message = "Epic resource not found.") {
    super(message);
    this.name = "EpicNotFoundError";
  }
}

export class EpicStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EpicStateError";
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type EpicRequestInput = {
  personId: string;
  kind: EpicRequestKind;
  jobTitle?: string | null;
  mirrorEpicId?: string | null;
  notes?: string | null;
};

export type EpicRequestRow = EpicRequest & {
  person: {
    id: string;
    name: string | null;
    netId: string | null;
    contactEmail: string | null;
    epicId: string | null;
  };
  ticket: {
    id: string;
    serviceRequestNumber: string | null;
  } | null;
};

export type TicketRow = YnhhTicket & {
  _count: { requests: number };
  submittedBy: { name: string | null };
};

// ---------------------------------------------------------------------------
// Internal permission guard
// ---------------------------------------------------------------------------

async function requireManageEpic(actorPersonId: string): Promise<void> {
  if (!(await can(actorPersonId, "volunteers.manage_epic"))) {
    throw new EpicForbiddenError("volunteers.manage_epic is required.");
  }
}

// ---------------------------------------------------------------------------
// createEpicRequest
// ---------------------------------------------------------------------------

/**
 * Creates an epic request.
 *
 * Self-service (actorPersonId === input.personId) is always permitted.
 * Creating for someone else requires volunteers.manage_epic.
 *
 * Validates:
 *   - Target person exists (EpicNotFoundError).
 *   - Target person is ACTIVE (EpicStateError).
 *   - No open (PENDING or SUBMITTED) request already exists (EpicStateError).
 *   - Kind NEW requires person has NO epicId (EpicStateError).
 *   - Kind MODIFY or RENEW requires person HAS epicId (EpicStateError).
 *
 * Audits "epic.request" with kind in after.
 *
 * Note on the duplicate-open check: the open-request guard is a find-then-create
 * with no DB unique constraint backstop, so two same-millisecond submissions from
 * the same person could both land; at clinic scale a manager simply cancels one.
 */
export async function createEpicRequest(
  actorPersonId: string,
  input: EpicRequestInput
): Promise<EpicRequest> {
  const isSelf = actorPersonId === input.personId;
  if (!isSelf && !(await can(actorPersonId, "volunteers.manage_epic"))) {
    throw new EpicForbiddenError("You can only submit an epic request for yourself.");
  }

  const person = await prisma.person.findUnique({ where: { id: input.personId } });
  if (!person) throw new EpicNotFoundError(`Person not found: ${input.personId}`);
  if (person.status !== "ACTIVE") {
    throw new EpicStateError("Cannot create an epic request for a non-ACTIVE person.");
  }

  const openRequest = await prisma.epicRequest.findFirst({
    where: {
      personId: input.personId,
      status: { in: ["PENDING", "SUBMITTED"] },
    },
  });
  if (openRequest) {
    throw new EpicStateError(
      `Person already has an open epic request (status: ${openRequest.status}).`
    );
  }

  if (input.kind === "NEW" && person.epicId) {
    throw new EpicStateError("Kind NEW requires the person to have no epicId on file.");
  }
  if ((input.kind === "MODIFY" || input.kind === "RENEW") && !person.epicId) {
    throw new EpicStateError(`Kind ${input.kind} requires the person to have an epicId on file.`);
  }

  const req = await prisma.epicRequest.create({
    data: {
      personId: input.personId,
      kind: input.kind,
      status: "PENDING",
      jobTitle: input.jobTitle ?? null,
      mirrorEpicId: input.mirrorEpicId ?? null,
      notes: input.notes ?? null,
      requestedById: actorPersonId,
    },
  });

  await recordAudit({
    actorPersonId,
    action: "epic.request",
    entityType: "EpicRequest",
    entityId: req.id,
    after: { personId: input.personId, kind: input.kind },
  });

  return req;
}

// ---------------------------------------------------------------------------
// myEpicPanel
// ---------------------------------------------------------------------------

/**
 * Returns the person's epicId and their open (PENDING or SUBMITTED) request.
 *
 * Trusts callers: the page gates this to the authenticated person.
 */
export async function myEpicPanel(
  personId: string
): Promise<{ epicId: string | null; openRequest: EpicRequest | null }> {
  const [person, openRequest] = await Promise.all([
    prisma.person.findUnique({ where: { id: personId } }),
    prisma.epicRequest.findFirst({
      where: {
        personId,
        status: { in: ["PENDING", "SUBMITTED"] },
      },
      orderBy: { createdAt: "desc" },
    }),
  ]);

  if (!person) return { epicId: null, openRequest: null };

  return { epicId: person.epicId, openRequest };
}

// ---------------------------------------------------------------------------
// listEpicRequests
// ---------------------------------------------------------------------------

/**
 * Returns a paginated list of epic requests.
 *
 * page defaults to 1, page size is 25. Filtered by status when given, newest
 * first. Each row includes person (id, name, netId, contactEmail, epicId) and
 * ticket (id, serviceRequestNumber) or null.
 *
 * counts is a groupBy across ALL requests regardless of the status filter.
 *
 * Trusts callers: the page gates this to manage_epic holders.
 */
export async function listEpicRequests(q: {
  status?: EpicRequestStatus;
  page?: number;
}): Promise<{ rows: EpicRequestRow[]; total: number; counts: Record<EpicRequestStatus, number> }> {
  const page = q.page ?? 1;
  const skip = (page - 1) * PAGE_SIZE;

  const where = q.status ? { status: q.status } : {};

  const [rows, total, groupBy] = await Promise.all([
    prisma.epicRequest.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip,
      take: PAGE_SIZE,
      include: {
        person: {
          select: { id: true, name: true, netId: true, contactEmail: true, epicId: true },
        },
        ticket: {
          select: { id: true, serviceRequestNumber: true },
        },
      },
    }),
    prisma.epicRequest.count({ where }),
    prisma.epicRequest.groupBy({
      by: ["status"],
      _count: { _all: true },
    }),
  ]);

  const zero: Record<EpicRequestStatus, number> = {
    PENDING: 0,
    SUBMITTED: 0,
    COMPLETED: 0,
    CANCELLED: 0,
  };
  const counts = groupBy.reduce((acc, row) => {
    acc[row.status] = row._count._all;
    return acc;
  }, zero);

  return { rows: rows as EpicRequestRow[], total, counts };
}

// ---------------------------------------------------------------------------
// createTicket
// ---------------------------------------------------------------------------

/**
 * Creates a YnhhTicket and moves all listed requests to SUBMITTED in one
 * transaction.
 *
 * Requires volunteers.manage_epic. All requestIds must be PENDING; any that
 * are not cause EpicStateError listing the offending ids. requestIds must be
 * non-empty.
 *
 * Audits "epic.ticket_create" with requestIds.
 */
export async function createTicket(
  actorPersonId: string,
  input: { requestIds: string[]; description?: string | null }
): Promise<YnhhTicket> {
  await requireManageEpic(actorPersonId);

  if (input.requestIds.length === 0) {
    throw new EpicStateError("requestIds must not be empty.");
  }

  const requests = await prisma.epicRequest.findMany({
    where: { id: { in: input.requestIds } },
    select: { id: true, status: true },
  });

  if (requests.length !== input.requestIds.length) {
    const foundIds = new Set(requests.map((r) => r.id));
    const missingIds = input.requestIds.filter((id) => !foundIds.has(id));
    throw new EpicStateError(
      `The following requests do not exist: ${missingIds.join(", ")}`
    );
  }

  const nonPending = requests.filter((r) => r.status !== "PENDING").map((r) => r.id);
  if (nonPending.length > 0) {
    throw new EpicStateError(
      `The following requests are not PENDING: ${nonPending.join(", ")}`
    );
  }

  const ticket = await prisma.$transaction(async (tx) => {
    const created = await tx.ynhhTicket.create({
      data: {
        status: "OPEN",
        submittedById: actorPersonId,
        description: input.description ?? null,
      },
    });

    await tx.epicRequest.updateMany({
      where: { id: { in: input.requestIds } },
      data: { ticketId: created.id, status: "SUBMITTED" },
    });

    return created;
  });

  await recordAudit({
    actorPersonId,
    action: "epic.ticket_create",
    entityType: "YnhhTicket",
    entityId: ticket.id,
    after: { requestIds: input.requestIds },
  });

  return ticket;
}

// ---------------------------------------------------------------------------
// setTicketServiceRequestNumber
// ---------------------------------------------------------------------------

/**
 * Sets the serviceRequestNumber on a ticket.
 *
 * Requires volunteers.manage_epic. Ticket must exist (EpicNotFoundError).
 * Audits "epic.ticket_sr".
 */
export async function setTicketServiceRequestNumber(
  actorPersonId: string,
  ticketId: string,
  srNumber: string
): Promise<void> {
  await requireManageEpic(actorPersonId);

  const ticket = await prisma.ynhhTicket.findUnique({ where: { id: ticketId } });
  if (!ticket) throw new EpicNotFoundError(`Ticket not found: ${ticketId}`);

  await prisma.ynhhTicket.update({
    where: { id: ticketId },
    data: { serviceRequestNumber: srNumber },
  });

  await recordAudit({
    actorPersonId,
    action: "epic.ticket_sr",
    entityType: "YnhhTicket",
    entityId: ticketId,
    after: { serviceRequestNumber: srNumber },
  });
}

// ---------------------------------------------------------------------------
// closeTicket
// ---------------------------------------------------------------------------

/**
 * Closes a ticket. Ticket must exist (EpicNotFoundError) and be OPEN
 * (EpicStateError if already CLOSED).
 *
 * Requires volunteers.manage_epic. Audits "epic.ticket_close".
 */
export async function closeTicket(actorPersonId: string, ticketId: string): Promise<void> {
  await requireManageEpic(actorPersonId);

  const ticket = await prisma.ynhhTicket.findUnique({ where: { id: ticketId } });
  if (!ticket) throw new EpicNotFoundError(`Ticket not found: ${ticketId}`);
  if (ticket.status === "CLOSED") {
    throw new EpicStateError("Ticket is already CLOSED.");
  }

  await prisma.ynhhTicket.update({
    where: { id: ticketId },
    data: { status: "CLOSED", closedAt: new Date() },
  });

  await recordAudit({
    actorPersonId,
    action: "epic.ticket_close",
    entityType: "YnhhTicket",
    entityId: ticketId,
    after: { status: "CLOSED" },
  });
}

// ---------------------------------------------------------------------------
// listTickets
// ---------------------------------------------------------------------------

/**
 * Returns all tickets: OPEN first then CLOSED, each newest-submittedAt first
 * within the group. Includes request count and submittedBy name.
 *
 * Trusts callers: the page gates this to manage_epic holders.
 */
export async function listTickets(): Promise<TicketRow[]> {
  const [open, closed] = await Promise.all([
    prisma.ynhhTicket.findMany({
      where: { status: "OPEN" },
      orderBy: { submittedAt: "desc" },
      include: {
        _count: { select: { requests: true } },
        submittedBy: { select: { name: true } },
      },
    }),
    prisma.ynhhTicket.findMany({
      where: { status: "CLOSED" },
      orderBy: { submittedAt: "desc" },
      include: {
        _count: { select: { requests: true } },
        submittedBy: { select: { name: true } },
      },
    }),
  ]);

  return [...open, ...closed] as TicketRow[];
}

// ---------------------------------------------------------------------------
// completeRequest
// ---------------------------------------------------------------------------

/**
 * Completes an epic request.
 *
 * Requires volunteers.manage_epic. Request must exist (EpicNotFoundError) and
 * be PENDING or SUBMITTED (EpicStateError otherwise).
 *
 * For kind NEW or MODIFY an epicId argument is REQUIRED (EpicStateError when
 * missing or blank). The epicId is written via updatePersonFields which diffs,
 * audits person.update, and enqueues the mirror outbox.
 *
 * For kind RENEW any provided epicId is IGNORED; the person's epicId is left
 * untouched.
 *
 * For kind DEACTIVATE the epicId argument is IGNORED and Person.epicId is
 * never cleared. Revocation is tracked via the request status; the epicId
 * is retained as a historical record per product decision. DEACTIVATE requests
 * may be completed for a person of any status (including OFFBOARDED).
 *
 * Access-granting kinds (NEW, MODIFY, RENEW) may only be completed for an
 * ACTIVE person (EpicStateError otherwise). This prevents stamping a fresh
 * epicId onto someone who has been offboarded, closing a security hole.
 *
 * Sets status COMPLETED + completedAt. Audits "epic.complete".
 *
 * Note on atomicity: updatePersonFields runs before the request-status update
 * and uses the global prisma client (it cannot join a tx). A crash between the
 * two writes leaves epicId written with the request still open; a retry is safe
 * because updatePersonFields diffs and no-ops on an unchanged epicId.
 */
export async function completeRequest(
  actorPersonId: string,
  requestId: string,
  epicId?: string
): Promise<void> {
  await requireManageEpic(actorPersonId);

  const req = await prisma.epicRequest.findUnique({ where: { id: requestId } });
  if (!req) throw new EpicNotFoundError(`EpicRequest not found: ${requestId}`);

  if (req.status !== "PENDING" && req.status !== "SUBMITTED") {
    throw new EpicStateError(
      `Cannot complete a request with status ${req.status}. Must be PENDING or SUBMITTED.`
    );
  }

  const person = await prisma.person.findUnique({ where: { id: req.personId } });
  if (!person) throw new EpicNotFoundError("Person for this request no longer exists.");

  // Access-granting kinds may only be completed for an ACTIVE person. This
  // prevents stamping a fresh epicId onto someone who has been offboarded and
  // removes the inconsistency with createEpicRequest (which already refuses a
  // non-active person). DEACTIVATE is exempt: completing it is the whole point
  // for a person who has left.
  if (req.kind !== "DEACTIVATE" && person.status !== "ACTIVE") {
    throw new EpicStateError(
      `Cannot complete a ${req.kind} request for a non-active person (status: ${person.status}).`
    );
  }

  let writtenEpicId: string | null = null;

  if (req.kind === "NEW" || req.kind === "MODIFY") {
    if (!epicId || !epicId.trim()) {
      throw new EpicStateError(`An epicId is required to complete a ${req.kind} request.`);
    }
    writtenEpicId = epicId.trim();
    try {
      await updatePersonFields(actorPersonId, req.personId, { epicId: writtenEpicId });
    } catch (err) {
      if (err instanceof PersonNotFoundError) {
        throw new EpicNotFoundError("Person for this request no longer exists.");
      }
      throw err;
    }
  }
  // RENEW and DEACTIVATE: leave Person.epicId untouched. DEACTIVATE keeps the
  // epicId as a historical record per product decision; revocation happens at
  // YNHH and is tracked by the request status, not by clearing the field.

  await prisma.epicRequest.update({
    where: { id: requestId },
    data: { status: "COMPLETED", completedAt: new Date() },
  });

  await recordAudit({
    actorPersonId,
    action: "epic.complete",
    entityType: "EpicRequest",
    entityId: requestId,
    // For NEW/MODIFY record the epicId actually written; for RENEW and DEACTIVATE omit it (no write occurred).
    after: { kind: req.kind, epicId: writtenEpicId },
  });
}

// ---------------------------------------------------------------------------
// cancelRequest
// ---------------------------------------------------------------------------

/**
 * Cancels an epic request. Request must exist (EpicNotFoundError) and be
 * PENDING or SUBMITTED (EpicStateError otherwise).
 *
 * Requires volunteers.manage_epic. reason must be non-blank (EpicStateError).
 *
 * Existing notes are preserved; "Cancelled: <reason>" is appended on a new
 * line (or set directly when notes is null).
 *
 * Audits "epic.cancel" with reason.
 */
export async function cancelRequest(
  actorPersonId: string,
  requestId: string,
  reason: string
): Promise<void> {
  await requireManageEpic(actorPersonId);

  if (!reason || !reason.trim()) {
    throw new EpicStateError("A non-blank reason is required to cancel a request.");
  }

  const req = await prisma.epicRequest.findUnique({ where: { id: requestId } });
  if (!req) throw new EpicNotFoundError(`EpicRequest not found: ${requestId}`);

  if (req.status !== "PENDING" && req.status !== "SUBMITTED") {
    throw new EpicStateError(
      `Cannot cancel a request with status ${req.status}. Must be PENDING or SUBMITTED.`
    );
  }

  const cancellationLine = `Cancelled: ${reason.trim()}`;
  const updatedNotes = req.notes ? `${req.notes}\n${cancellationLine}` : cancellationLine;

  await prisma.epicRequest.update({
    where: { id: requestId },
    data: { status: "CANCELLED", notes: updatedNotes },
  });

  await recordAudit({
    actorPersonId,
    action: "epic.cancel",
    entityType: "EpicRequest",
    entityId: requestId,
    after: { reason: reason.trim() },
  });
}

// ---------------------------------------------------------------------------
// sendEpicEmail
// ---------------------------------------------------------------------------

/**
 * Sends (queues) an email for an epic request.
 *
 * Requires volunteers.manage_epic. Request and person must exist
 * (EpicNotFoundError). Person must have a contactEmail (EpicStateError).
 *
 * Builds params including departmentNames from the person's ACTIVE memberships
 * in the ACTIVE term. Renders via renderEmail and enqueues with queueEmail.
 *
 * Audits "epic.email" with the template key.
 */
export async function sendEpicEmail(
  actorPersonId: string,
  requestId: string,
  template: EpicTemplateKey
): Promise<void> {
  await requireManageEpic(actorPersonId);

  const req = await prisma.epicRequest.findUnique({
    where: { id: requestId },
    include: { person: true },
  });
  if (!req) throw new EpicNotFoundError(`EpicRequest not found: ${requestId}`);

  const person = req.person;
  if (!person.contactEmail) {
    throw new EpicStateError("Person does not have a contactEmail.");
  }

  // Resolve ACTIVE memberships in the ACTIVE term.
  const activeTerm = await prisma.term.findFirst({
    where: { status: "ACTIVE" },
    orderBy: { startDate: "desc" },
  });

  let departmentNames: string[] = [];
  if (activeTerm) {
    const memberships = await prisma.termMembership.findMany({
      where: {
        personId: person.id,
        termId: activeTerm.id,
        status: "ACTIVE",
      },
      include: { department: { select: { name: true } } },
    });
    departmentNames = memberships.map((m) => m.department.name).sort();
  }

  const params: EpicEmailParams = {
    personName: person.name ?? "",
    netId: person.netId,
    contactEmail: person.contactEmail,
    epicId: person.epicId,
    departmentNames,
    // DEACTIVATE has no onboarding/activation/renewal email variant, so it maps
    // to undefined here (the epic email templates only model NEW/MODIFY/RENEW).
    kind: req.kind === "DEACTIVATE" ? undefined : req.kind,
  };

  const contextBuilders: Record<EpicTemplateKey, (p: EpicEmailParams) => Record<string, unknown>> = {
    "epic-onboarding": epicOnboardingContext,
    "epic-activation": epicActivationContext,
    "epic-password-reset": epicPasswordResetContext,
  };
  const { subject, html } = await renderEmail(template, contextBuilders[template](params));

  const epicTeamsSummary: Record<EpicTemplateKey, string> = {
    "epic-onboarding": "Your EPIC access onboarding has an update. Open HAVEN Hub for details.",
    "epic-activation": "Your EPIC access has been activated. Open HAVEN Hub for details.",
    "epic-password-reset": "Your EPIC password was reset. Open HAVEN Hub for details.",
  };

  // Global prisma client is intentional: there is no surrounding domain write to be transactional with.
  await notify(prisma, {
    type: template,
    person: {
      id: person.id,
      entraObjectId: person.entraObjectId,
      contactEmail: person.contactEmail,
    },
    email: { subject, html },
    teams: {
      title: "EPIC access update",
      summary: epicTeamsSummary[template],
      link: `${await getSetting<string>("app.baseUrl")}/volunteers`,
    },
    triggeredById: actorPersonId,
  });

  await recordAudit({
    actorPersonId,
    action: "epic.email",
    entityType: "EpicRequest",
    entityId: requestId,
    after: { template },
  });
}

// ---------------------------------------------------------------------------
// updateRequestDetails
// ---------------------------------------------------------------------------

/**
 * Updates jobTitle and/or mirrorEpicId on an open epic request.
 *
 * Requires volunteers.manage_epic (EpicForbiddenError). Request must exist
 * (EpicNotFoundError) and be PENDING or SUBMITTED (EpicStateError otherwise).
 *
 * Only keys present in input are written; undefined means "leave untouched".
 * null or "" clears the field to null. Non-empty strings are trimmed.
 *
 * Audits "epic.update_details" with before/after of both fields.
 */
export async function updateRequestDetails(
  actorPersonId: string,
  requestId: string,
  input: { jobTitle?: string | null; mirrorEpicId?: string | null }
): Promise<void> {
  await requireManageEpic(actorPersonId);

  const req = await prisma.epicRequest.findUnique({ where: { id: requestId } });
  if (!req) throw new EpicNotFoundError(`EpicRequest not found: ${requestId}`);

  if (req.status !== "PENDING" && req.status !== "SUBMITTED") {
    throw new EpicStateError(
      `Cannot update details on a request with status ${req.status}. Must be PENDING or SUBMITTED.`
    );
  }

  // Build the update data: undefined = skip field; null/"" = clear; string = trim and set.
  const data: { jobTitle?: string | null; mirrorEpicId?: string | null } = {};

  if (input.jobTitle !== undefined) {
    const v = input.jobTitle;
    data.jobTitle = v === null || v === "" ? null : v.trim();
  }
  if (input.mirrorEpicId !== undefined) {
    const v = input.mirrorEpicId;
    data.mirrorEpicId = v === null || v === "" ? null : v.trim();
  }

  if (Object.keys(data).length > 0) {
    await prisma.epicRequest.update({ where: { id: requestId }, data });
  }

  await recordAudit({
    actorPersonId,
    action: "epic.update_details",
    entityType: "EpicRequest",
    entityId: requestId,
    before: {
      jobTitle: req.jobTitle,
      mirrorEpicId: req.mirrorEpicId,
    },
    after: {
      jobTitle: data.jobTitle !== undefined ? data.jobTitle : req.jobTitle,
      mirrorEpicId: data.mirrorEpicId !== undefined ? data.mirrorEpicId : req.mirrorEpicId,
    },
  });
}

// ---------------------------------------------------------------------------
// emailHistory
// ---------------------------------------------------------------------------

/**
 * Returns epic-template EmailLog rows for the given personIds, grouped into
 * a Map keyed by personId, newest first.
 *
 * Only rows whose template is an epic template key are included. Non-epic
 * template rows are silently excluded.
 *
 * Trusts callers: the page gates this to manage_epic holders.
 */
export async function emailHistory(personIds: string[]): Promise<Map<string, EmailLog[]>> {
  if (personIds.length === 0) return new Map();

  const epicTemplateKeys: EpicTemplateKey[] = [
    "epic-onboarding",
    "epic-activation",
    "epic-password-reset",
  ];

  const rows = await prisma.emailLog.findMany({
    where: {
      personId: { in: personIds },
      template: { in: epicTemplateKeys },
    },
    orderBy: { createdAt: "desc" },
  });

  const result = new Map<string, EmailLog[]>();
  for (const row of rows) {
    if (!row.personId) continue;
    const list = result.get(row.personId) ?? [];
    list.push(row);
    result.set(row.personId, list);
  }

  return result;
}
