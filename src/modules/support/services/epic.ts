/**
 * Support module epic request service.
 *
 * Permission model:
 *   ENFORCED internally (call-site cannot bypass):
 *     createEpicRequest      - self OR support.manage_requests
 *     createTicket           - support.manage_requests
 *     setTicketServiceRequestNumber - support.manage_requests
 *     completeRequest        - support.manage_requests
 *     sendEpicEmail          - support.manage_requests
 *     cancelEpicRequest      - support.manage_requests
 *     linkEpicRequestToTicket - support.manage_requests
 *
 * updatePersonFields (from @/platform/people) is used for all epicId writes:
 * it diffs and audits person.update. Do not duplicate that logic here.
 *
 * createTicket, completeRequest, and cancelEpicRequest also call into
 * epic-ticket-sync.ts (onEpicSubmitted / onEpicResolved) once their own write
 * has committed: any EpicRequest attached to a support ticket
 * (EpicRequest.techRequestId) drives that TechRequest's status to
 * AWAITING_YNHH on submission and back to IN_PROGRESS once nothing on it is
 * still with YNHH. See that module's doc comment for the full transition
 * rules -- this file never writes TechRequest.status directly.
 */

import type { EpicRequest, YnhhTicket } from "@prisma/client";
import type { EpicRequestKind } from "@prisma/client";
import { prisma } from "@/platform/db";
import { recordAudit } from "@/platform/audit";
import { can } from "@/platform/rbac/engine";
import { updatePersonFields, PersonNotFoundError } from "@/platform/people";
import { getActiveTerm } from "@/platform/terms/active-term";
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
import { onEpicSubmitted, onEpicResolved } from "./epic-ticket-sync";

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

// ---------------------------------------------------------------------------
// Internal permission guard
// ---------------------------------------------------------------------------

async function requireManageEpic(actorPersonId: string): Promise<void> {
  if (!(await can(actorPersonId, "support.manage_requests"))) {
    throw new EpicForbiddenError("support.manage_requests is required.");
  }
}

/**
 * Creates an epic request.
 *
 * Self-service (actorPersonId === input.personId) is always permitted.
 * Creating for someone else requires support.manage_requests.
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
  if (!isSelf && !(await can(actorPersonId, "support.manage_requests"))) {
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

/**
 * Creates a YnhhTicket and moves all listed requests to SUBMITTED in one
 * transaction.
 *
 * Requires support.manage_requests. All requestIds must be PENDING; any that
 * are not cause EpicStateError listing the offending ids. requestIds must be
 * non-empty.
 *
 * The pre-check reads status outside the write, so the SUBMITTED move is an
 * atomic claim (updateMany scoped to status PENDING): under a concurrent
 * double-submit only one caller matches all rows; the loser matches fewer,
 * throws, and rolls back its own ticket rather than reassigning a request or
 * orphaning a ticket.
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

    const claimed = await tx.epicRequest.updateMany({
      where: { id: { in: input.requestIds }, status: "PENDING" },
      data: { ticketId: created.id, status: "SUBMITTED" },
    });
    if (claimed.count !== input.requestIds.length) {
      throw new EpicStateError(
        "One or more of these requests were already submitted by a concurrent action. Refresh and try again."
      );
    }

    return created;
  });

  await recordAudit({
    actorPersonId,
    action: "epic.ticket_create",
    entityType: "YnhhTicket",
    entityId: ticket.id,
    after: { requestIds: input.requestIds },
  });

  // See epic-ticket-sync.ts: moves every linked TechRequest among these
  // requests to AWAITING_YNHH. Runs after the transaction above has
  // committed, matching the rest of this file's "side effects after the
  // write" ordering.
  await onEpicSubmitted(actorPersonId, ticket.id);

  return ticket;
}

/**
 * Sets the serviceRequestNumber on a ticket.
 *
 * Requires support.manage_requests. Ticket must exist (EpicNotFoundError).
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

/**
 * Completes an epic request.
 *
 * Requires support.manage_requests. Request must exist (EpicNotFoundError) and
 * be PENDING or SUBMITTED (EpicStateError otherwise).
 *
 * For kind NEW or MODIFY an epicId argument is REQUIRED (EpicStateError when
 * missing or blank). The epicId is written via updatePersonFields which diffs
 * and audits person.update.
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

  // Validate the epicId is present BEFORE claiming, so a NEW/MODIFY missing its
  // epicId never leaves the row marked COMPLETED without one.
  const needsEpicId = req.kind === "NEW" || req.kind === "MODIFY";
  if (needsEpicId && (!epicId || !epicId.trim())) {
    throw new EpicStateError(`An epicId is required to complete a ${req.kind} request.`);
  }
  const writtenEpicId: string | null = needsEpicId ? epicId!.trim() : null;

  // Atomic claim BEFORE any side effect, matching cancelEpicRequest /
  // createTicket / reconcile: the status read above and this write are not in one
  // transaction, so without the precondition a concurrent cancel could be
  // silently reverted (its CANCELLED flipped to COMPLETED) and Person.epicId
  // stamped for a request that was actually cancelled. Claiming first means a
  // lost race writes nothing.
  const claimed = await prisma.epicRequest.updateMany({
    where: { id: requestId, status: { in: ["PENDING", "SUBMITTED"] } },
    data: { status: "COMPLETED", completedAt: new Date() },
  });
  if (claimed.count !== 1) {
    throw new EpicStateError("This request was already resolved by a concurrent action.");
  }

  if (writtenEpicId) {
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

  await recordAudit({
    actorPersonId,
    action: "epic.complete",
    entityType: "EpicRequest",
    entityId: requestId,
    // For NEW/MODIFY record the epicId actually written; for RENEW and DEACTIVATE omit it (no write occurred).
    after: { kind: req.kind, epicId: writtenEpicId },
  });

  // See epic-ticket-sync.ts: moves the linked TechRequest back to IN_PROGRESS
  // once nothing attached to it is still SUBMITTED. Never auto-resolves.
  await onEpicResolved(actorPersonId, requestId, "COMPLETED");
}

/**
 * Sends (queues) an email for an epic request.
 *
 * Requires support.manage_requests. Request and person must exist
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
  const activeTerm = await getActiveTerm();

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
    // Read at send time, not baked into the template, so IT can update it the
    // moment YNHH rotates it instead of waiting on a deploy. Only the activation
    // email uses it; the other two context builders ignore it.
    temporaryPassword: await getSetting<string>("epic.temporaryPassword"),
  };

  const contextBuilders: Record<EpicTemplateKey, (p: EpicEmailParams) => Record<string, unknown>> = {
    "epic-onboarding": epicOnboardingContext,
    "epic-activation": epicActivationContext,
    "epic-password-reset": epicPasswordResetContext,
  };
  const { subject, html } = await renderEmail(template, contextBuilders[template](params));

  const epicTeamsSummary: Record<EpicTemplateKey, string> = {
    "epic-onboarding": "Your Epic access onboarding has an update. Open HAVEN Hub for details.",
    "epic-activation": "Your Epic access has been activated. Open HAVEN Hub for details.",
    "epic-password-reset": "Your Epic password was reset. Open HAVEN Hub for details.",
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
      title: "Epic access update",
      summary: epicTeamsSummary[template],
      link: `${await getSetting<string>("app.baseUrl")}/my-info`,
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

/**
 * Cancels an OPEN (PENDING or SUBMITTED) Epic request (support.manage_requests).
 * Used to discard a wrongly-attached, wrong-kind, or superseded request so a
 * corrected one can be submitted, including one that is already blocking a
 * re-submission from the Epic generator. SUBMITTED requests are cancellable too:
 * the YNHH email is sent manually, so "SUBMITTED" only records intent to submit,
 * and an admin must be able to abandon one made in error. Cancelling never
 * touches Person.epicId (revocation, if needed, happens via a DEACTIVATE
 * request). A COMPLETED or already-CANCELLED request cannot be cancelled.
 * Audits "epic.cancel".
 */
export async function cancelEpicRequest(actorPersonId: string, requestId: string): Promise<void> {
  await requireManageEpic(actorPersonId);
  const req = await prisma.epicRequest.findUnique({ where: { id: requestId } });
  if (!req) throw new EpicNotFoundError(`EpicRequest not found: ${requestId}`);
  if (req.status !== "PENDING" && req.status !== "SUBMITTED") {
    throw new EpicStateError(
      `Cannot cancel a request with status ${req.status}. Only an open (PENDING or SUBMITTED) request can be cancelled.`
    );
  }
  // Atomic claim: only flip a row still in an open status, so a concurrent
  // complete/cancel can't be clobbered between the read above and this write.
  const claimed = await prisma.epicRequest.updateMany({
    where: { id: requestId, status: { in: ["PENDING", "SUBMITTED"] } },
    data: { status: "CANCELLED" },
  });
  if (claimed.count !== 1) {
    throw new EpicStateError(
      "This request was just resolved by a concurrent action. Refresh and try again."
    );
  }
  await recordAudit({
    actorPersonId,
    action: "epic.cancel",
    entityType: "EpicRequest",
    entityId: requestId,
    after: { status: "CANCELLED" },
  });

  // See epic-ticket-sync.ts: moves the linked TechRequest back to IN_PROGRESS
  // once nothing attached to it is still SUBMITTED. Never auto-resolves.
  await onEpicResolved(actorPersonId, requestId, "CANCELLED");
}

/**
 * Links an EXISTING Epic request to a support ticket by ticket number. Pure
 * association: does not change the request's status, kind, or YNHH ticket.
 *
 * Requires support.manage_requests. The request must exist (EpicNotFoundError).
 * The number must resolve to a TechRequest (EpicStateError otherwise). Refuses
 * to silently move a request already linked to a DIFFERENT ticket
 * (EpicStateError naming the current ticket); a no-op if already linked to this
 * same ticket. Audits "epic.link_ticket".
 */
export async function linkEpicRequestToTicket(
  actorPersonId: string,
  epicRequestId: string,
  ticketNumber: number
): Promise<void> {
  await requireManageEpic(actorPersonId);

  const req = await prisma.epicRequest.findUnique({ where: { id: epicRequestId } });
  if (!req) throw new EpicNotFoundError(`EpicRequest not found: ${epicRequestId}`);

  const ticket = await prisma.techRequest.findUnique({ where: { number: ticketNumber } });
  if (!ticket) throw new EpicStateError(`No support ticket #${ticketNumber} found.`);

  if (req.techRequestId === ticket.id) return; // already linked to this ticket

  if (req.techRequestId) {
    const current = await prisma.techRequest.findUnique({
      where: { id: req.techRequestId },
      select: { number: true },
    });
    throw new EpicStateError(
      `This Epic request is already linked to support ticket #${current?.number ?? "?"}.`
    );
  }

  await prisma.epicRequest.update({
    where: { id: epicRequestId },
    data: { techRequestId: ticket.id },
  });

  await recordAudit({
    actorPersonId,
    action: "epic.link_ticket",
    entityType: "EpicRequest",
    entityId: epicRequestId,
    after: { techRequestId: ticket.id, ticketNumber },
  });
}

