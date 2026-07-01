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
 * Permission checks are NOT this service's concern; the page gates via
 * requirePermission("admin.access"). Services trust their callers.
 */

import type { Person, Department } from "@prisma/client";
import { prisma } from "@/platform/db";
import { getActiveTerm } from "@/platform/terms/active-term";

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
// this page lives under (/admin/itcm).
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
    status: "OPEN" | "CLOSED";
    submittedAt: Date;
    closedAt: Date | null;
    submittedBy: { name: string };
  };
  requests: {
    id: string;
    kind: "NEW" | "MODIFY" | "RENEW" | "DEACTIVATE";
    status: string;
    person: { name: string; epicId: string | null };
  }[];
};

export async function getEpicRequestHistory(): Promise<EpicRequestHistoryRow[]> {
  const tickets = await prisma.ynhhTicket.findMany({
    orderBy: { submittedAt: "desc" },
    include: {
      submittedBy: { select: { name: true } },
      requests: {
        include: {
          person: { select: { name: true, epicId: true } },
        },
      },
    },
  });

  return tickets.map((t) => ({
    ticket: {
      id: t.id,
      serviceRequestNumber: t.serviceRequestNumber ?? null,
      description: t.description ?? null,
      status: t.status as "OPEN" | "CLOSED",
      submittedAt: t.submittedAt,
      closedAt: t.closedAt ?? null,
      submittedBy: { name: t.submittedBy.name },
    },
    requests: t.requests.map((r) => ({
      id: r.id,
      kind: r.kind as "NEW" | "MODIFY" | "RENEW" | "DEACTIVATE",
      status: r.status,
      person: { name: r.person.name, epicId: r.person.epicId },
    })),
  }));
}

/**
 * Marks a YNHH ticket as closed, stamping closedAt with the current time.
 * Closed tickets move out of the active Tracker view and into History --
 * see EpicRequestTabs, which filters getEpicRequestHistory's results by
 * ticket.status rather than querying separately.
 */
export async function closeTicket(ticketId: string) {
  return prisma.ynhhTicket.update({
    where: { id: ticketId },
    data: {
      status: "CLOSED",
      closedAt: new Date(),
    },
  });
}

/** Sets or updates the YNHH service request number on a ticket. */
export async function updateServiceRequestNumber(ticketId: string, serviceRequestNumber: string) {
  return prisma.ynhhTicket.update({
    where: { id: ticketId },
    data: { serviceRequestNumber },
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
    where: { kind: "DEACTIVATE", status: "PENDING" },
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
 * Trusts its caller for permissions: the generate route gates on admin.access.
 */
export async function reconcileDeactivationRequests(
  actorPersonId: string,
  personIds: string[],
  ticketId: string
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    for (const personId of personIds) {
      const open = await tx.epicRequest.findFirst({
        where: { personId, kind: "DEACTIVATE", status: { in: ["PENDING", "SUBMITTED"] } },
        select: { id: true },
      });
      if (open) {
        await tx.epicRequest.update({
          where: { id: open.id },
          data: { status: "SUBMITTED", ticketId },
        });
      } else {
        await tx.epicRequest.create({
          data: { personId, kind: "DEACTIVATE", status: "SUBMITTED", ticketId, requestedById: actorPersonId },
        });
      }
    }
  });
}
