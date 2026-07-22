/**
 * Term Epic roll-up: who on a term's roster needs an Epic request, and of which
 * kind, derived live from the roster rather than materialized ahead of time.
 *
 * Nothing here writes. EpicRequest rows are created only when ITCM submits a
 * batch, through the generate route and submitEpicRequests.
 *
 * Trusts its caller for permissions: /support/epic gates on
 * support.manage_requests.
 */

import type { Track } from "@prisma/client";
import { prisma } from "@/platform/db";
import { buildTermOptions, type TermOption } from "@/platform/terms/term-options";
import { loadClearanceMap } from "@/modules/onboarding/services/clearance";
import { loadEffectiveSteps } from "@/modules/onboarding/services/step-config";
import { SupportNotFoundError } from "./tech-request";
import {
  classifyEpicKind,
  resolveRollupNeed,
  type RollupGroupKind,
  type RollupMembership,
} from "./epic-rollup-classify";

export type { RollupGroupKind } from "./epic-rollup-classify";

export type EpicRollupRow = {
  personId: string;
  name: string;
  netId: string | null;
  contactEmail: string | null;
  epicId: string | null;
  /** ACTIVE memberships in the target term. */
  departments: { id: string; name: string; kind: Track }[];
  /** Department names from the person's most recent prior term, for a MODIFY diff. */
  priorDepartmentNames: string[];
  kind: RollupGroupKind;
  /** "ticket" when an explicitly-raised request set the kind, "derived" otherwise. */
  kindSource: "derived" | "ticket";
  /** SOME-department member with no deciding signal: shown but unchecked. */
  optional: boolean;
  /** Every onboarding step satisfied (blocking and non-blocking alike). */
  cleared: boolean;
  /** Labels of the unsatisfied steps, for the amber chip. Empty when cleared. */
  missingLabels: string[];
  existingRequest: {
    id: string;
    status: "PENDING" | "SUBMITTED";
    ticketId: string | null;
    techRequestNumber: number | null;
  } | null;
  /** Non-null when submitting this person would be refused. */
  blockedReason: string | null;
  /** False when blocked, or already SUBMITTED onto a YNHH ticket. */
  selectable: boolean;
};

export type EpicRollup = {
  term: {
    id: string;
    code: string;
    name: string;
    /** Term end date as YYYY-MM-DD, the default access end date for a batch. */
    endDateIso: string;
  };
  groups: Record<RollupGroupKind, EpicRollupRow[]>;
};

/** Terms offerable in the Term batch switcher, newest first, archived omitted. */
export async function listBatchTermOptions(): Promise<TermOption[]> {
  const terms = await prisma.term.findMany({
    orderBy: { startDate: "desc" },
    select: { id: true, code: true, status: true },
  });
  // buildTermOptions leads with a "Global" (empty value) entry for RBAC pickers;
  // a batch always targets a concrete term, so drop it.
  return buildTermOptions(terms).filter((o) => o.value !== "");
}

export async function loadTermEpicRollup(termId: string): Promise<EpicRollup> {
  const term = await prisma.term.findUnique({ where: { id: termId } });
  if (!term) throw new SupportNotFoundError(`Term not found: ${termId}`);

  const memberships = await prisma.termMembership.findMany({
    where: { termId, status: "ACTIVE" },
    include: {
      person: { select: { id: true, name: true, netId: true, contactEmail: true, epicId: true, status: true } },
      department: {
        select: { id: true, name: true, requiresEpicDirector: true, requiresEpicVolunteer: true },
      },
    },
  });

  const personIds = [...new Set(memberships.map((m) => m.personId))];
  if (personIds.length === 0) {
    return {
      term: { id: term.id, code: term.code, name: term.name, endDateIso: isoDay(term.endDate) },
      groups: { NEW: [], MODIFY: [], RENEW: [] },
    };
  }

  const [priorMemberships, contracts, openRequests, clearance, steps] = await Promise.all([
    // ACTIVE only: offboarding flips every membership a person holds to REMOVED,
    // so an offboarded-and-returning member correctly reads as having no prior
    // term and lands in MODIFY (reactivate) rather than RENEW.
    prisma.termMembership.findMany({
      where: {
        personId: { in: personIds },
        status: "ACTIVE",
        term: { startDate: { lt: term.startDate } },
      },
      select: {
        personId: true,
        departmentId: true,
        termId: true,
        department: { select: { name: true } },
        term: { select: { startDate: true } },
      },
    }),
    prisma.onboardingContract.findMany({
      where: {
        status: "PROMOTED",
        promotedPersonId: { in: personIds },
        acceptance: { application: { cycle: { termId } } },
      },
      select: { promotedPersonId: true, epicNeeded: true },
    }),
    prisma.epicRequest.findMany({
      where: { personId: { in: personIds }, status: { in: ["PENDING", "SUBMITTED"] } },
      orderBy: { createdAt: "asc" },
      include: { techRequest: { select: { number: true } } },
    }),
    loadClearanceMap(personIds, termId),
    loadEffectiveSteps(termId),
  ]);

  // Per person, the department ids and names of their MOST RECENT prior term.
  const priorByPerson = new Map<string, { startDate: Date; ids: string[]; names: string[] }>();
  for (const m of priorMemberships) {
    const current = priorByPerson.get(m.personId);
    if (!current || m.term.startDate > current.startDate) {
      priorByPerson.set(m.personId, {
        startDate: m.term.startDate,
        ids: [m.departmentId],
        names: [m.department.name],
      });
    } else if (m.term.startDate.getTime() === current.startDate.getTime()) {
      current.ids.push(m.departmentId);
      current.names.push(m.department.name);
    }
  }

  const contractByPerson = new Map(
    contracts
      .filter((c): c is typeof c & { promotedPersonId: string } => c.promotedPersonId !== null)
      .map((c) => [c.promotedPersonId, c.epicNeeded])
  );

  // Group open requests by person. Oldest first (the query orders by createdAt),
  // so the row shown is the one a human raised first.
  const requestsByPerson = new Map<string, typeof openRequests>();
  for (const r of openRequests) {
    const list = requestsByPerson.get(r.personId) ?? [];
    list.push(r);
    requestsByPerson.set(r.personId, list);
  }

  const membershipsByPerson = new Map<string, typeof memberships>();
  for (const m of memberships) {
    const list = membershipsByPerson.get(m.personId) ?? [];
    list.push(m);
    membershipsByPerson.set(m.personId, list);
  }

  const groups: Record<RollupGroupKind, EpicRollupRow[]> = { NEW: [], MODIFY: [], RENEW: [] };

  for (const personId of personIds) {
    const personMemberships = membershipsByPerson.get(personId) ?? [];
    if (personMemberships.length === 0) continue;
    const person = personMemberships[0].person;

    const rollupMemberships: RollupMembership[] = personMemberships.map((m) => ({
      departmentId: m.departmentId,
      kind: m.kind,
      requiresEpicDirector: m.department.requiresEpicDirector,
      requiresEpicVolunteer: m.department.requiresEpicVolunteer,
    }));

    const need = resolveRollupNeed(rollupMemberships, {
      contractEpicNeeded: contractByPerson.get(personId) ?? false,
      hasEpicId: person.epicId !== null,
    });
    if (!need.needed) continue;

    const prior = priorByPerson.get(personId) ?? null;
    const derivedKind = classifyEpicKind({
      hasEpicId: person.epicId !== null,
      termDepartmentIds: personMemberships.map((m) => m.departmentId),
      priorDepartmentIds: prior ? prior.ids : null,
    });

    const personRequests = requestsByPerson.get(personId) ?? [];
    const deactivation = personRequests.find((r) => r.kind === "DEACTIVATE") ?? null;
    // DEACTIVATE never places a row; the grant-side request (if any) does.
    const grantRequest = personRequests.find((r) => r.kind !== "DEACTIVATE") ?? null;
    // A request raised from a support ticket carries a kind a human chose
    // deliberately, so it overrides the derived one.
    const ticketKind =
      grantRequest && grantRequest.techRequestId !== null
        ? (grantRequest.kind as RollupGroupKind)
        : null;
    const kind = ticketKind ?? derivedKind;

    let blockedReason: string | null = null;
    if (person.status !== "ACTIVE") {
      blockedReason = `Person is not active (${person.status.toLowerCase()}).`;
    } else if (deactivation) {
      blockedReason = "Has an open deactivation request; resolve it before granting access.";
    } else if (kind === "NEW" && person.epicId) {
      blockedReason = "Already has an Epic ID, so a new-account request would be refused.";
    } else if (kind !== "NEW" && !person.epicId) {
      blockedReason = `Has no Epic ID on file, so a ${kind.toLowerCase()} request would be refused.`;
    }

    const summary = clearance.get(personId);
    const missingLabels = (summary?.missing ?? []).map((k) => steps.get(k)?.label ?? k);

    groups[kind].push({
      personId,
      name: person.name,
      netId: person.netId,
      contactEmail: person.contactEmail,
      epicId: person.epicId,
      departments: personMemberships.map((m) => ({
        id: m.department.id,
        name: m.department.name,
        kind: m.kind,
      })),
      priorDepartmentNames: prior ? [...new Set(prior.names)].sort() : [],
      kind,
      kindSource: ticketKind ? "ticket" : "derived",
      optional: need.optional,
      cleared: summary?.cleared ?? false,
      missingLabels,
      existingRequest: grantRequest
        ? {
            id: grantRequest.id,
            status: grantRequest.status as "PENDING" | "SUBMITTED",
            ticketId: grantRequest.ticketId,
            techRequestNumber: grantRequest.techRequest?.number ?? null,
          }
        : null,
      blockedReason,
      selectable: blockedReason === null && grantRequest?.status !== "SUBMITTED",
    });
  }

  for (const key of ["NEW", "MODIFY", "RENEW"] as RollupGroupKind[]) {
    groups[key].sort((a, b) => a.name.localeCompare(b.name));
  }

  return {
    term: { id: term.id, code: term.code, name: term.name, endDateIso: isoDay(term.endDate) },
    groups,
  };
}

/** A stored calendar date rendered as YYYY-MM-DD. Term dates are stored at UTC
 *  midnight, so slicing the ISO string preserves the calendar day. */
function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}
