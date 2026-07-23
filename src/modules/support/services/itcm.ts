/**
 * ITCM admin service: Epic request data queries.
 *
 * Provides the data layer for the Epic request PDF generator:
 *   - listDepartmentsWithMembers: all active departments with their active
 *     term members (directors and volunteers), used to populate the person
 *     selector and find Epic ID mirror candidates.
 *   - findMirrorPerson: given a department and role, finds another active
 *     member in that department who already has an epicId set. Used to
 *     auto-populate the "person with similar job functions" fields.
 *   - getPeopleByIds: returns full person records for a set of ids,
 *     used to build the spreadsheet rows for bulk requests.
 *
 * Most read queries here trust their callers; the page gates via
 * requirePermission("support.manage_requests"). The exceptions are the two
 * incident mutations (logYnhhIncident, resolveIncident), which enforce
 * support.manage_requests internally (defense in depth) since they create and
 * mutate data.
 */

import type { Person, Department, YnhhTicket, EpicRequestKind } from "@prisma/client";
import { prisma } from "@/platform/db";
import { getActiveTerm } from "@/platform/terms/active-term";
import { recordAudit } from "@/platform/audit";
import { can } from "@/platform/rbac/engine";
import { MANAGE, SupportConflictError, SupportForbiddenError, SupportNotFoundError, SupportStateError } from "./tech-request";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MemberLite = {
  id: string;
  name: string;
  netId: string | null;
  contactEmail: string | null;
  epicId: string | null;
  kind: "DIRECTOR" | "VOLUNTEER";
};

export type DepartmentWithMembers = {
  department: Department;
  directors: MemberLite[];
  volunteers: MemberLite[];
};

/**
 * An Epic request authorizer: an ITCM director who can sign off on a YNHH
 * service request. Sourced live from the current term's ITCM directors, so the
 * list rotates with the directorship and the contact details come from each
 * person's record (no hardcoded directory to keep in sync).
 */
export type EpicAuthorizer = {
  /** Person id: the stable key the form submits and the route re-resolves. */
  id: string;
  name: string;
  /** First+last name initials, used for PDF filenames and email subjects. */
  initials: string;
  /** From Person.phone; "" when unset rather than a stale hardcoded number. */
  phone: string;
  /** From Person.contactEmail; "" when unset. */
  email: string;
};

// The department whose directors authorize Epic requests. "ITCM" is the seeded,
// unique code for "IT & Compliance Management" (prisma/seed.ts) and the module
// this page lives under (/support/epic).
const ITCM_DEPARTMENT_CODE = "ITCM";

// ---------------------------------------------------------------------------
// listEpicAuthorizers
// ---------------------------------------------------------------------------

/**
 * Initials from a full name: the first letter of the first and last
 * whitespace-separated tokens, uppercased. "Caprice Culkin" -> "CC",
 * "Mary Jane Watson" -> "MW", "Cher" -> "C", "" -> "".
 */
export function authorizerInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "";
  if (parts.length === 1) return parts[0][0].toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/**
 * Returns the people who can authorize Epic requests: the ACTIVE directors of
 * the ITCM department in the current (ACTIVE) term. Replaces the hardcoded
 * AUTHORIZERS directory so the picker rotates as directors change each term and
 * personal phone/email are read from each person's record. Returns an empty
 * list when there is no active term or no ITCM director, so the caller can
 * disable generation rather than offer a stale name.
 */
export async function listEpicAuthorizers(): Promise<EpicAuthorizer[]> {
  const activeTerm = await getActiveTerm();
  if (!activeTerm) return [];

  const memberships = await prisma.termMembership.findMany({
    where: {
      termId: activeTerm.id,
      status: "ACTIVE",
      kind: "DIRECTOR",
      department: { code: ITCM_DEPARTMENT_CODE },
    },
    include: { person: { select: { id: true, name: true, phone: true, contactEmail: true } } },
    orderBy: { person: { name: "asc" } },
  });

  // De-dupe by person (the membership unique constraint already prevents a
  // person holding the same director slot twice, but guard anyway).
  const byId = new Map<string, EpicAuthorizer>();
  for (const m of memberships) {
    if (byId.has(m.person.id)) continue;
    byId.set(m.person.id, {
      id: m.person.id,
      name: m.person.name,
      initials: authorizerInitials(m.person.name),
      phone: m.person.phone ?? "",
      email: m.person.contactEmail ?? "",
    });
  }
  return [...byId.values()];
}

/**
 * Returns all active departments with their active-term members.
 *
 * Only includes departments that have at least one ACTIVE membership in the
 * current term. Members are sorted by name within each role group. Used to
 * populate the person selector on the Epic request page.
 */
export async function listDepartmentsWithMembers(): Promise<DepartmentWithMembers[]> {
  const activeTerm = await getActiveTerm();
  if (!activeTerm) return [];

  const memberships = await prisma.termMembership.findMany({
    where: { termId: activeTerm.id, status: "ACTIVE" },
    include: {
      person: true,
      department: true,
    },
    orderBy: [{ department: { code: "asc" } }, { person: { name: "asc" } }],
  });

  // Group by department.
  const byDept = new Map<string, DepartmentWithMembers>();
  for (const m of memberships) {
    if (!byDept.has(m.departmentId)) {
      byDept.set(m.departmentId, {
        department: m.department,
        directors: [],
        volunteers: [],
      });
    }
    const entry = byDept.get(m.departmentId)!;
    const member: MemberLite = {
      id: m.person.id,
      name: m.person.name,
      netId: m.person.netId,
      contactEmail: m.person.contactEmail,
      epicId: m.person.epicId,
      kind: m.kind,
    };
    if (m.kind === "DIRECTOR") {
      entry.directors.push(member);
    } else {
      entry.volunteers.push(member);
    }
  }

  return [...byDept.values()];
}

/**
 * Finds a reference person for the "Epic ID to mirror" field.
 *
 * Searches the active term for another ACTIVE member in the same department
 * with the same role (director mirrors director, volunteer mirrors volunteer)
 * who already has an epicId set. Returns the first match sorted by name, or
 * null if none exists.
 *
 * Directors should mirror directors; volunteers should mirror volunteers.
 * This keeps access levels appropriate for the role.
 */
export async function findMirrorPerson(
  departmentId: string,
  kind: "DIRECTOR" | "VOLUNTEER",
  options: { excludePersonIds?: string[]; termId?: string } = {}
): Promise<{ name: string; epicId: string } | null> {
  const { excludePersonIds = [], termId } = options;

  // Reuse a term id the caller already resolved; otherwise look up the active term.
  let resolvedTermId = termId;
  if (!resolvedTermId) {
    const activeTerm = await getActiveTerm();
    if (!activeTerm) return null;
    resolvedTermId = activeTerm.id;
  }

  const membership = await prisma.termMembership.findFirst({
    where: {
      termId: resolvedTermId,
      departmentId,
      kind,
      status: "ACTIVE",
      personId: excludePersonIds.length ? { notIn: excludePersonIds } : undefined,
      person: { epicId: { not: null } },
    },
    include: { person: { select: { name: true, epicId: true } } },
    orderBy: { person: { name: "asc" } },
  });

  if (!membership?.person.epicId) return null;
  return { name: membership.person.name, epicId: membership.person.epicId };
}

/**
 * Returns full person records for a set of person ids.
 *
 * Used to build spreadsheet rows for bulk requests; the page collects
 * selected person ids and passes them here to get name, email, netId, epicId.
 */
export async function getPeopleByIds(ids: string[]): Promise<Person[]> {
  return prisma.person.findMany({
    where: { id: { in: ids } },
    orderBy: { name: "asc" },
  });
}


// ---------------------------------------------------------------------------
// getEpicRequestHistory
// ---------------------------------------------------------------------------

/**
 * Returns all YNHH tickets with their associated Epic requests and people,
 * ordered by submission date descending. Used to populate the tracker tab.
 *
 * Business days since submission is computed client-side from submittedAt
 * since it depends on the current date.
 */
export type EpicRequestHistoryRow = {
  ticket: {
    id: string;
    serviceRequestNumber: string | null;
    description: string | null;
    subject: string | null;
    resolution: string | null;
    status: "OPEN" | "CLOSED";
    submittedAt: Date;
    closedAt: Date | null;
    submittedBy: { name: string };
  };
  /** The person a one-off incident concerns; null for Epic-batch tickets. */
  about: { name: string } | null;
  attachments: { id: string; filename: string }[];
  requests: {
    id: string;
    kind: "NEW" | "MODIFY" | "RENEW" | "DEACTIVATE";
    status: string;
    person: { name: string; epicId: string | null };
    techRequest: { id: string; number: number } | null;
  }[];
};

export async function getEpicRequestHistory(): Promise<EpicRequestHistoryRow[]> {
  const tickets = await prisma.ynhhTicket.findMany({
    orderBy: { submittedAt: "desc" },
    include: {
      submittedBy: { select: { name: true } },
      person: { select: { name: true } },
      attachments: { select: { id: true, filename: true } },
      requests: {
        include: {
          person: { select: { name: true, epicId: true } },
          techRequest: { select: { id: true, number: true } },
        },
      },
    },
  });

  return tickets.map((t) => ({
    ticket: {
      id: t.id,
      serviceRequestNumber: t.serviceRequestNumber ?? null,
      description: t.description ?? null,
      subject: t.subject ?? null,
      resolution: t.resolution ?? null,
      status: t.status as "OPEN" | "CLOSED",
      submittedAt: t.submittedAt,
      closedAt: t.closedAt ?? null,
      submittedBy: { name: t.submittedBy.name },
    },
    about: t.person ? { name: t.person.name } : null,
    attachments: t.attachments.map((a) => ({ id: a.id, filename: a.filename })),
    requests: t.requests.map((r) => ({
      id: r.id,
      kind: r.kind as "NEW" | "MODIFY" | "RENEW" | "DEACTIVATE",
      status: r.status,
      person: { name: r.person.name, epicId: r.person.epicId },
      techRequest: r.techRequest ? { id: r.techRequest.id, number: r.techRequest.number } : null,
    })),
  }));
}

/**
 * Marks a YNHH ticket as closed, stamping closedAt with the current time.
 * Closed tickets move out of the active Tracker view and into History --
 * see EpicRequestTabs, which filters getEpicRequestHistory's results by
 * ticket.status rather than querying separately.
 *
 * Audits "epic.ticket_close" so a tracker close leaves the same trail as the
 * single-ticket close on the request detail page.
 */
export async function closeTicket(actorPersonId: string, ticketId: string) {
  const ticket = await prisma.ynhhTicket.update({
    where: { id: ticketId },
    data: {
      status: "CLOSED",
      closedAt: new Date(),
    },
  });

  await recordAudit({
    actorPersonId,
    action: "epic.ticket_close",
    entityType: "YnhhTicket",
    entityId: ticketId,
    after: { status: "CLOSED" },
  });

  return ticket;
}

/**
 * Sets or updates the YNHH service request number on a ticket. Audits
 * "epic.ticket_sr" so a tracker SR edit leaves the same trail as the
 * single-ticket SR edit on the request detail page.
 */
export async function updateServiceRequestNumber(
  actorPersonId: string,
  ticketId: string,
  serviceRequestNumber: string
) {
  const ticket = await prisma.ynhhTicket.update({
    where: { id: ticketId },
    data: { serviceRequestNumber },
  });

  await recordAudit({
    actorPersonId,
    action: "epic.ticket_sr",
    entityType: "YnhhTicket",
    entityId: ticketId,
    after: { serviceRequestNumber },
  });

  return ticket;
}

// ---------------------------------------------------------------------------
// logYnhhIncident / resolveIncident
// ---------------------------------------------------------------------------

export type LogYnhhIncidentInput = {
  subject: string;
  description?: string | null;
  serviceRequestNumber?: string | null;
  personId?: string | null;
};

/**
 * Logs a standalone YNHH incident (an email/ticket sent to YNHH IT that is
 * not tied to an Epic access request), e.g. a general outage report or a
 * one-off account question. Creates a YnhhTicket with no linked EpicRequests.
 *
 * Enforces support.manage_requests internally (SupportForbiddenError):
 * YNHH incident logging is a manager-only action, unlike createTechRequest.
 *
 * Audits "ynhh.incident_log".
 */
export async function logYnhhIncident(
  actorPersonId: string,
  input: LogYnhhIncidentInput
): Promise<YnhhTicket> {
  if (!(await can(actorPersonId, MANAGE))) {
    throw new SupportForbiddenError(`The ${MANAGE} permission is required.`);
  }

  const subject = input.subject?.trim();
  if (!subject) throw new SupportStateError("A subject is required.");

  const ticket = await prisma.ynhhTicket.create({
    data: {
      subject,
      description: input.description?.trim() || null,
      serviceRequestNumber: input.serviceRequestNumber?.trim() || null,
      personId: input.personId || null,
      status: "OPEN",
      submittedById: actorPersonId,
    },
  });

  await recordAudit({
    actorPersonId,
    action: "ynhh.incident_log",
    entityType: "YnhhTicket",
    entityId: ticket.id,
    after: { subject },
  });

  return ticket;
}

/**
 * Resolves a standalone YNHH incident: records the resolution notes, marks it
 * CLOSED, and stamps closedAt. Requires support.manage_requests
 * (SupportForbiddenError). Throws SupportNotFoundError for a missing ticket
 * and SupportStateError for a blank resolution or an already-CLOSED ticket.
 *
 * Audits "ynhh.incident_resolve".
 */
export async function resolveIncident(
  actorPersonId: string,
  ticketId: string,
  resolution: string
): Promise<void> {
  if (!(await can(actorPersonId, MANAGE))) {
    throw new SupportForbiddenError(`The ${MANAGE} permission is required.`);
  }

  const ticket = await prisma.ynhhTicket.findUnique({ where: { id: ticketId } });
  if (!ticket) throw new SupportNotFoundError();
  if (ticket.status === "CLOSED") {
    throw new SupportStateError("This incident is already closed.");
  }

  const trimmedResolution = resolution?.trim();
  if (!trimmedResolution) throw new SupportStateError("A resolution is required.");

  await prisma.ynhhTicket.update({
    where: { id: ticketId },
    data: {
      status: "CLOSED",
      resolution: trimmedResolution,
      closedAt: new Date(),
    },
  });

  await recordAudit({
    actorPersonId,
    action: "ynhh.incident_resolve",
    entityType: "YnhhTicket",
    entityId: ticketId,
  });
}

// ---------------------------------------------------------------------------
// listIncidentPeople
// ---------------------------------------------------------------------------

/**
 * Returns ACTIVE people for the one-off incident form's person selector
 * (the "about" field). Ordered by name.
 */
export async function listIncidentPeople(): Promise<{ id: string; name: string }[]> {
  return prisma.person.findMany({
    where: { status: "ACTIVE" },
    select: { id: true, name: true },
    orderBy: { name: "asc" },
  });
}

// ---------------------------------------------------------------------------
// listPendingDeactivations
// ---------------------------------------------------------------------------

export type PendingDeactivation = {
  id: string;
  name: string;
  netId: string | null;
  contactEmail: string | null;
  epicId: string | null;
  departmentNames: string[];
};

/**
 * Returns people who have an open (PENDING) DEACTIVATE EpicRequest: the people
 * an admin can batch into a YNHH deactivation service request. Offboarded
 * people are no longer active members, so they do not appear in
 * listDepartmentsWithMembers; this is the person source for the deactivate flow.
 *
 * departmentNames is best-effort: the person's most recent term memberships
 * (any status) for display only.
 */
export async function listPendingDeactivations(): Promise<PendingDeactivation[]> {
  const requests = await prisma.epicRequest.findMany({
    // Defence in depth for offboard convergence. A DEACTIVATE is a revocation
    // task for somebody who has left, so a person who is ACTIVE again does not
    // belong in IT's outstanding-work list no matter how their request came to
    // still be open. The writers are supposed to cancel it on reactivation
    // (setPersonStatusField and promoteContracts both call
    // cancelOpenDeactivationRequestsTx), but this query is the last point before
    // a revocation becomes real YNHH paperwork, so it does not rely on that.
    where: { kind: "DEACTIVATE", status: "PENDING", person: { status: { not: "ACTIVE" } } },
    include: {
      person: {
        select: {
          id: true,
          name: true,
          netId: true,
          contactEmail: true,
          epicId: true,
          memberships: {
            select: { department: { select: { name: true } } },
            orderBy: { term: { startDate: "desc" } },
          },
        },
      },
    },
    orderBy: { person: { name: "asc" } },
  });

  // De-duplicate by person (a person should have at most one open DEACTIVATE,
  // but guard against duplicates) and dedupe department names.
  const byPerson = new Map<string, PendingDeactivation>();
  for (const r of requests) {
    if (byPerson.has(r.person.id)) continue;
    const departmentNames = [...new Set(r.person.memberships.map((m) => m.department.name))];
    byPerson.set(r.person.id, {
      id: r.person.id,
      name: r.person.name,
      netId: r.person.netId,
      contactEmail: r.person.contactEmail,
      epicId: r.person.epicId,
      departmentNames,
    });
  }
  return [...byPerson.values()];
}

/**
 * Links the selected people's deactivation requests to a YNHH ticket when an
 * admin generates a deactivation service request. For each person: reuse an
 * open (PENDING/SUBMITTED) DEACTIVATE request if one exists (the one queued at
 * offboard), attaching it to the ticket and marking it SUBMITTED; otherwise
 * create a SUBMITTED DEACTIVATE request attached to the ticket (supports an
 * ad-hoc deactivation for someone who was not auto-queued).
 *
 * Trusts its caller for permissions: the generate route gates on support.manage_requests.
 *
 * Creates the YnhhTicket INSIDE the same transaction as the request links and
 * returns it (mirrors submitEpicRequests), so a mid-batch failure rolls the ticket
 * back too instead of committing an OPEN ticket with zero linked requests (F18).
 */
export async function reconcileDeactivationRequests(
  actorPersonId: string,
  personIds: string[],
  ticketDescription: string
): Promise<YnhhTicket> {
  return prisma.$transaction(async (tx) => {
    // Classify each person's existing open DEACTIVATE request first. A request
    // already SUBMITTED onto a ticket is in flight; re-pointing it to a fresh
    // ticket would strip it from -- and orphan -- its current one (e.g. a manager
    // clicking Generate twice). So only PENDING requests (offboard-queued, no
    // ticket yet) are moved, and persons with no request get a new one.
    const toAttach: { personId: string; existingId: string | null }[] = [];
    for (const personId of personIds) {
      const open = await tx.epicRequest.findFirst({
        where: { personId, kind: "DEACTIVATE", status: { in: ["PENDING", "SUBMITTED"] } },
        select: { id: true, status: true, ticketId: true },
      });
      if (open && open.status === "SUBMITTED" && open.ticketId) continue;
      toAttach.push({ personId, existingId: open?.id ?? null });
    }
    // Nothing new to submit: don't create an empty (orphan) ticket. Mirrors the
    // duplicate rejection submitEpicRequests already performs on the grant path.
    if (toAttach.length === 0) {
      throw new SupportStateError(
        "Every selected person already has a submitted deactivation request. Refresh to see current status."
      );
    }
    const ticket = await tx.ynhhTicket.create({
      data: { submittedById: actorPersonId, description: ticketDescription, status: "OPEN" },
    });
    for (const { personId, existingId } of toAttach) {
      if (existingId) {
        // Atomic claim: only flip a still-PENDING request. Without the status
        // precondition, a concurrent reconcile (e.g. a double-clicked Generate)
        // could re-point a request the other run already SUBMITTED onto its own
        // ticket, orphaning it there. Mirrors createTicket's updateMany claim.
        const claimed = await tx.epicRequest.updateMany({
          where: { id: existingId, status: "PENDING" },
          data: { status: "SUBMITTED", ticketId: ticket.id },
        });
        if (claimed.count !== 1) {
          throw new SupportStateError(
            "A selected deactivation was just submitted by another action. Refresh to see current status."
          );
        }
      } else {
        await tx.epicRequest.create({
          data: { personId, kind: "DEACTIVATE", status: "SUBMITTED", ticketId: ticket.id, requestedById: actorPersonId },
        });
      }
    }
    return ticket;
  });
}

/**
 * Creates the YNHH ticket and its SUBMITTED access-granting (NEW/MODIFY/RENEW)
 * Epic requests for the generate route's non-deactivate path, enforcing the
 * same invariants createEpicRequest guarantees so this bulk/PDF path cannot
 * manufacture a duplicate open request or a NEW request for someone who
 * already has an Epic ID.
 *
 * Mirrors reconcileDeactivationRequests (the DEACTIVATE path) but rejects
 * duplicates instead of reusing them. Validation and both writes run in one
 * transaction, so any violation throws before the ticket is committed (no
 * orphan ticket, no partially-created batch):
 *   - every person must still exist and be ACTIVE (SupportNotFoundError /
 *     SupportStateError);
 *   - NEW requires no epicId, MODIFY/RENEW requires an epicId (SupportStateError);
 *   - no person may already have an open (PENDING/SUBMITTED) request
 *     (SupportStateError).
 *
 * Trusts its caller for permissions: the generate route gates on
 * support.manage_requests. Returns the created ticket.
 */
export async function submitEpicRequests(
  actorPersonId: string,
  kind: "NEW" | "MODIFY" | "RENEW",
  ticketDescription: string,
  requests: { personId: string; mirrorEpicId: string | null }[]
): Promise<YnhhTicket> {
  const personIds = requests.map((r) => r.personId);

  return prisma.$transaction(async (tx) => {
    const people = await tx.person.findMany({
      where: { id: { in: personIds } },
      select: { id: true, name: true, status: true, epicId: true },
    });
    const byId = new Map(people.map((p) => [p.id, p]));

    for (const { personId } of requests) {
      const person = byId.get(personId);
      if (!person) throw new SupportNotFoundError(`Person not found: ${personId}`);
      if (person.status !== "ACTIVE") {
        throw new SupportStateError(`${person.name} is not an active member; cannot submit an Epic request.`);
      }
      if (kind === "NEW" && person.epicId) {
        throw new SupportStateError(`${person.name} already has an Epic ID; submit a Modify or Renew instead of New.`);
      }
      if ((kind === "MODIFY" || kind === "RENEW") && !person.epicId) {
        throw new SupportStateError(`${person.name} has no Epic ID on file; submit a New request instead of ${kind}.`);
      }
    }

    const open = await tx.epicRequest.findMany({
      where: { personId: { in: personIds }, status: { in: ["PENDING", "SUBMITTED"] } },
      include: { person: { select: { name: true } } },
    });
    if (open.length > 0) {
      const uniqueNames = [...new Set(open.map((r) => r.person.name))];
      const names = uniqueNames.join(", ");
      throw new SupportConflictError(
        `An open Epic request already exists for: ${names}. Cancel or complete it in the Tracker before submitting another.`,
        uniqueNames
      );
    }

    const ticket = await tx.ynhhTicket.create({
      data: { submittedById: actorPersonId, description: ticketDescription, status: "OPEN" },
    });
    await tx.epicRequest.createMany({
      data: requests.map((r) => ({
        personId: r.personId,
        kind,
        status: "SUBMITTED",
        mirrorEpicId: r.mirrorEpicId,
        requestedById: actorPersonId,
        ticketId: ticket.id,
      })),
    });

    return ticket;
  });
}

// ---------------------------------------------------------------------------
// listPendingEpicRequests
// ---------------------------------------------------------------------------

export type PendingEpicRequestRow = {
  id: string;
  kind: EpicRequestKind;
  createdAt: Date;
  /** Free-text context, e.g. the Epic access details a promoted volunteer supplied. */
  notes: string | null;
  person: { id: string; name: string | null; epicId: string | null };
  techRequest: { id: string; number: number; subject: string } | null;
};

/**
 * Un-submitted access-granting Epic requests awaiting a YNHH ticket: PENDING,
 * not yet grouped under a ticket, and NOT a deactivation. These are the rows the
 * /support/epic "Pending" tab batches into a YNHH ticket via createTicket.
 *
 * Includes access-granting requests regardless of origin -- both attach-origin
 * requests (raised from a support ticket, techRequestId set) and the NEW request
 * that recruitment promotion creates for a promoted volunteer who needs Epic
 * (techRequestId null). Previously this was scoped to techRequestId: { not: null },
 * which also excluded promotion's NEW requests: they were invisible here, absent
 * from the Tracker (no ticket), and un-cancellable, yet still blocked
 * submit/attach as a duplicate -- deadlocking Epic provisioning for new members.
 *
 * DEACTIVATE requests are excluded because they have their own pipeline
 * (listPendingDeactivations / reconcileDeactivationRequests); batching one
 * through the generic createTicket path here would bypass that pipeline.
 */
export async function listPendingEpicRequests(): Promise<PendingEpicRequestRow[]> {
  const rows = await prisma.epicRequest.findMany({
    where: { status: "PENDING", ticketId: null, kind: { not: "DEACTIVATE" } },
    orderBy: { createdAt: "asc" },
    include: {
      person: { select: { id: true, name: true, epicId: true } },
      techRequest: { select: { id: true, number: true, subject: true } },
    },
  });
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    createdAt: r.createdAt,
    notes: r.notes,
    person: { id: r.person.id, name: r.person.name, epicId: r.person.epicId },
    techRequest: r.techRequest
      ? { id: r.techRequest.id, number: r.techRequest.number, subject: r.techRequest.subject }
      : null,
  }));
}
