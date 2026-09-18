/**
 * Availability change requests: what a volunteer asked to change about the
 * availability their application recorded, and what their department did about
 * it.
 *
 * The request is NOT a row. It is the onboarding contract's own
 * availabilityChangeNeeded / availabilityChangeRequest answer, written once at
 * onboarding and never revised. Only the disposition is stored
 * (AvailabilityChangeDecision), so "pending" means no decision row exists yet for
 * that (contract, department). Nothing had to be backfilled for the contracts
 * that already carry a request, and there is no status on the contract that
 * could fall out of step with this table.
 *
 * Everything here is keyed per DEPARTMENT because a dual appointment is two
 * departments sharing ONE contract (the second acceptance has no contract of its
 * own). Each director decides for their own department and applies the change to
 * their own TermMembership.
 *
 * Scoping deliberately reuses the shift-request authority
 * (manageableRequestDepartmentIds), NOT the builder's. A schedule.manage_requests
 * holder who is not a builder is exactly the person /schedule/requests exists
 * for, and the builder's own scope check would refuse them. That is also why the
 * override write below is spelled out here instead of calling the builder's
 * setAvailabilityOverride, which re-checks builder scope.
 */

import { prisma } from "@/platform/db";
import { isoDateKey } from "@/platform/dates";
import { recordAudit } from "@/platform/audit";
import { resolveAvailability } from "@/modules/schedule/engine/availability";
import { applicationAvailabilityDates } from "@/platform/recruitment/incoming-roster";
import { comparePersonName } from "@/platform/person-name";
import { manageableRequestDepartmentIds, canManageRequestsForDept } from "./requests";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class AvailabilityRequestForbiddenError extends Error {
  constructor(message = "You do not manage requests for that department.") {
    super(message);
    this.name = "AvailabilityRequestForbiddenError";
  }
}

export class AvailabilityRequestNotFoundError extends Error {
  constructor(message = "That availability request no longer exists.") {
    super(message);
    this.name = "AvailabilityRequestNotFoundError";
  }
}

export class AvailabilityRequestValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AvailabilityRequestValidationError";
  }
}

export const ALREADY_DECIDED_MESSAGE =
  "Someone has already decided this request for your department.";
export const NO_MEMBERSHIP_MESSAGE =
  "They are not on this term's roster yet, so there is no availability to change. Dismiss the request instead, or apply it once the roster is built.";
export const ARCHIVED_TERM_MESSAGE = "That term is archived and can no longer be changed.";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AvailabilityRequestDecision = {
  outcome: "APPLIED" | "DISMISSED";
  note: string | null;
  decidedAt: Date;
  decidedByName: string;
};

export type AvailabilityRequestRow = {
  contractId: string;
  departmentId: string;
  /** Null until roster build creates the Person. */
  personId: string | null;
  /** Null until roster build; without one there is no override to write. */
  membershipId: string | null;
  personName: string;
  legalFirstName: string;
  lastName: string;
  /** The volunteer's own words. Never blank: a blank request is not a request. */
  request: string;
  /** Their availability as it stands right now, and which tier that came from. */
  currentDates: Date[];
  tier: "DIRECTOR" | "SELF" | "BASELINE";
  /** Null while pending. */
  decision: AvailabilityRequestDecision | null;
};

/** One department's pending requests, for the reminder cron. */
export type PendingAvailabilitySummary = {
  departmentId: string;
  departmentName: string;
  termId: string;
  rows: Array<{ personName: string; request: string }>;
};

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

async function scopeCheck(actorPersonId: string, departmentId: string): Promise<void> {
  if (!(await canManageRequestsForDept(actorPersonId, departmentId))) {
    throw new AvailabilityRequestForbiddenError();
  }
}

/**
 * Every contract carrying an availability request for one department, across the
 * given terms, decided or not.
 *
 * The department is matched by CODE against any acceptance on the application,
 * not just the acceptance the contract hangs off: a dual appointment's second
 * department shares the first one's contract, and matching only the contract's
 * own acceptance would hide the request from the department that never had one.
 * This mirrors onboardingNotesByMember, which feeds the builder the same answer.
 */
async function loadRows(opts: {
  departmentId: string;
  departmentCode: string;
  termIds: string[];
}): Promise<Array<{ row: AvailabilityRequestRow; termId: string }>> {
  if (opts.termIds.length === 0) return [];

  const terms = await prisma.term.findMany({
    where: { id: { in: opts.termIds } },
    select: { id: true, clinicDates: true },
  });
  const clinicDatesByTerm = new Map(terms.map((t) => [t.id, t.clinicDates]));

  const contracts = await prisma.onboardingContract.findMany({
    where: {
      // A contract still PENDING has not been filled in, so its request columns
      // are empty by definition; SUBMITTED and PROMOTED are the two states that
      // can carry an answer.
      status: { in: ["SUBMITTED", "PROMOTED"] },
      availabilityChangeNeeded: true,
      acceptance: {
        application: {
          status: { not: "WITHDRAWN" },
          cycle: { termId: { in: opts.termIds } },
          acceptances: { some: { departmentCode: opts.departmentCode } },
        },
      },
    },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      availabilityChangeRequest: true,
      promotedPersonId: true,
      availabilityDecisions: {
        where: { departmentId: opts.departmentId },
        select: {
          outcome: true,
          note: true,
          decidedAt: true,
          decidedBy: { select: { name: true } },
        },
      },
      acceptance: {
        select: {
          application: {
            select: {
              answers: true,
              applicant: {
                select: {
                  applicantPersonId: true,
                  applicantPerson: {
                    select: { id: true, name: true, legalFirstName: true, lastName: true },
                  },
                },
              },
              cycle: { select: { termId: true } },
            },
          },
        },
      },
    },
  });

  // The person this contract belongs to, when there is one. promotedPersonId is
  // who roster build resolved; applicantPersonId covers a returner who signed in
  // to apply but has not been promoted yet. Either way a missing person means the
  // roster has not been built for them, and there is no membership to override.
  const personIds = [
    ...new Set(
      contracts
        .map((c) => c.promotedPersonId ?? c.acceptance.application.applicant.applicantPersonId)
        .filter((id): id is string => id !== null),
    ),
  ];

  // Looked up WITHOUT `kind`. TermMembership is unique on
  // (personId, termId, departmentId, kind), and nobody is both a DIRECTOR and a
  // VOLUNTEER of the same department in the same term, so the first three
  // identify the row. That also avoids re-deriving the cycle-track-to-kind
  // mapping here, where a drift from the recruitment side would silently point
  // the override at no row at all.
  const memberships = personIds.length
    ? await prisma.termMembership.findMany({
        where: {
          personId: { in: personIds },
          departmentId: opts.departmentId,
          termId: { in: opts.termIds },
          status: "ACTIVE",
        },
        select: {
          id: true,
          personId: true,
          termId: true,
          baselineAvailability: true,
          selfAvailabilityDates: true,
          availabilityUpdatedAt: true,
          directorAvailabilityDates: true,
          directorAvailabilitySetAt: true,
        },
      })
    : [];
  const membershipByKey = new Map(memberships.map((m) => [`${m.personId}:${m.termId}`, m]));

  const out: Array<{ row: AvailabilityRequestRow; termId: string }> = [];

  for (const c of contracts) {
    // A blank answer beside a "yes" is not a request. schedulingNotesOf applies
    // the same trim before showing one in the builder, and the two surfaces must
    // agree or the badge count will not match the page.
    const request = c.availabilityChangeRequest?.trim();
    if (!request) continue;

    const termId = c.acceptance.application.cycle.termId;
    const applicant = c.acceptance.application.applicant;
    const personId = c.promotedPersonId ?? applicant.applicantPersonId;
    const membership = personId ? membershipByKey.get(`${personId}:${termId}`) ?? null : null;

    // On the roster: the resolved tier, exactly as the builder shows it. Not yet:
    // what their application said, narrowed to the term's clinic calendar, which
    // is the literal truth for someone who has no membership to carry the other
    // two tiers.
    const resolved = membership
      ? resolveAvailability({
          baseline: membership.baselineAvailability,
          selfDates: membership.selfAvailabilityDates,
          selfUpdatedAt: membership.availabilityUpdatedAt,
          directorDates: membership.directorAvailabilityDates,
          directorSetAt: membership.directorAvailabilitySetAt,
        })
      : {
          dates: applicationAvailabilityDates(
            c.acceptance.application.answers,
            clinicDatesByTerm.get(termId) ?? [],
          ),
          tier: "BASELINE" as const,
        };

    const decided = c.availabilityDecisions[0] ?? null;

    out.push({
      termId,
      row: {
        contractId: c.id,
        departmentId: opts.departmentId,
        personId,
        membershipId: membership?.id ?? null,
        // The Person's name wins when there is one: an application can be years
        // old, and the roster shows this human by their Person name everywhere
        // else. The contract name is the only one an incoming person has.
        personName: applicant.applicantPerson?.name ?? `${c.firstName} ${c.lastName}`.trim(),
        legalFirstName: applicant.applicantPerson?.legalFirstName ?? c.firstName,
        lastName: applicant.applicantPerson?.lastName ?? c.lastName,
        request,
        currentDates: [...resolved.dates].sort((a, b) => a.getTime() - b.getTime()),
        tier: resolved.tier,
        decision: decided
          ? {
              outcome: decided.outcome,
              note: decided.note,
              decidedAt: decided.decidedAt,
              decidedByName: decided.decidedBy.name,
            }
          : null,
      },
    });
  }

  return out;
}

/** The department's code, which is how acceptances name a department. */
async function departmentCode(departmentId: string): Promise<string> {
  const dept = await prisma.department.findUnique({
    where: { id: departmentId },
    select: { code: true },
  });
  if (!dept) throw new AvailabilityRequestNotFoundError("That department no longer exists.");
  return dept.code;
}

/**
 * One request, resolved for deciding: the row plus the term it belongs to.
 *
 * Throws NotFound rather than returning null for a contract that carries no
 * request, belongs to another department, or does not exist, because from the
 * caller's side those are the same thing: there is nothing here to decide.
 */
async function loadOne(
  contractId: string,
  departmentId: string,
): Promise<{ row: AvailabilityRequestRow; termId: string }> {
  const code = await departmentCode(departmentId);
  const terms = await prisma.term.findMany({
    where: { status: { in: ["ACTIVE", "PLANNING", "ARCHIVED"] } },
    select: { id: true },
  });
  const found = (
    await loadRows({ departmentId, departmentCode: code, termIds: terms.map((t) => t.id) })
  ).find((r) => r.row.contractId === contractId);
  if (!found) throw new AvailabilityRequestNotFoundError();
  return found;
}

/** Canonical clinic Dates for the given keys, or a readable refusal. */
async function canonicalClinicDates(termId: string, dateKeys: string[]): Promise<Date[]> {
  const term = await prisma.term.findUnique({
    where: { id: termId },
    select: { status: true, clinicDates: true },
  });
  if (!term) throw new AvailabilityRequestNotFoundError("That term no longer exists.");
  if (term.status === "ARCHIVED") {
    throw new AvailabilityRequestValidationError(ARCHIVED_TERM_MESSAGE);
  }

  const canonicalByKey = new Map(term.clinicDates.map((d) => [isoDateKey(d), d]));
  const bad = dateKeys.filter((k) => !canonicalByKey.has(k));
  if (bad.length > 0) {
    throw new AvailabilityRequestValidationError(
      `The following dates are not clinic dates: ${bad.join(", ")}`,
    );
  }
  return [...new Set(dateKeys)]
    .map((k) => canonicalByKey.get(k)!)
    .sort((a, b) => a.getTime() - b.getTime());
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * Every availability request for one (department, term): still pending first,
 * then the ones already decided, each by name.
 */
export async function listAvailabilityRequests(
  actorPersonId: string,
  departmentId: string,
  termId: string,
): Promise<AvailabilityRequestRow[]> {
  await scopeCheck(actorPersonId, departmentId);
  const code = await departmentCode(departmentId);
  const rows = (await loadRows({ departmentId, departmentCode: code, termIds: [termId] })).map(
    (r) => r.row,
  );

  // Pending first: a director opening this page is here to decide, and the
  // decided list is history. Array.sort is stable, so the name order inside each
  // group survives.
  return rows
    .sort((a, b) =>
      comparePersonName(
        { legalFirstName: a.legalFirstName, lastName: a.lastName },
        { legalFirstName: b.legalFirstName, lastName: b.lastName },
      ),
    )
    .sort((a, b) => Number(a.decision !== null) - Number(b.decision !== null));
}

/**
 * How many availability requests this person still has to decide, across every
 * department they manage requests for, in the live and next terms.
 *
 * Counts (contract, department) PAIRS, not contracts: a dual appointment is one
 * contract that two departments each have to decide. Shares loadRows with the
 * page so the badge and the page can never disagree about what counts, including
 * the blank-text rule.
 */
export async function countPendingAvailabilityRequests(personId: string): Promise<number> {
  const departmentIds = await manageableRequestDepartmentIds(personId);
  if (departmentIds.length === 0) return 0;

  // ARCHIVED terms are excluded for the same reason the shift-request badge
  // excludes them: nothing about them can be decided anywhere in the app, so
  // counting them is a number the director can never work down.
  const [departments, terms] = await Promise.all([
    prisma.department.findMany({
      where: { id: { in: departmentIds } },
      select: { id: true, code: true },
    }),
    prisma.term.findMany({
      where: { status: { in: ["ACTIVE", "PLANNING"] } },
      select: { id: true },
    }),
  ]);
  const termIds = terms.map((t) => t.id);

  const counts = await Promise.all(
    departments.map(async (d) =>
      (await loadRows({ departmentId: d.id, departmentCode: d.code, termIds })).filter(
        (r) => r.row.decision === null,
      ).length,
    ),
  );
  return counts.reduce((a, b) => a + b, 0);
}

/**
 * Every department with availability requests still waiting, for the reminder
 * cron. Live and next terms only, for the reason above.
 */
export async function pendingAvailabilityRequests(): Promise<PendingAvailabilitySummary[]> {
  const [departments, terms] = await Promise.all([
    prisma.department.findMany({ select: { id: true, code: true, name: true } }),
    prisma.term.findMany({
      where: { status: { in: ["ACTIVE", "PLANNING"] } },
      select: { id: true },
    }),
  ]);
  const termIds = terms.map((t) => t.id);

  const perDept = await Promise.all(
    departments.map(async (d) => {
      const pending = (
        await loadRows({ departmentId: d.id, departmentCode: d.code, termIds })
      ).filter((r) => r.row.decision === null);
      // One entry per (department, term): approvers are resolved per term, since
      // a next-term request routes to that term's directors.
      const byTerm = new Map<string, PendingAvailabilitySummary>();
      for (const { row, termId } of pending) {
        const key = termId;
        if (!byTerm.has(key)) {
          byTerm.set(key, {
            departmentId: d.id,
            departmentName: d.name,
            termId,
            rows: [],
          });
        }
        byTerm.get(key)!.rows.push({ personName: row.personName, request: row.request });
      }
      return [...byTerm.values()];
    }),
  );

  return perDept.flat();
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/**
 * Apply the change: set this department's director override to `dateKeys` and
 * record the request as APPLIED.
 *
 * The dates are the DIRECTOR'S, not the volunteer's. The request is free text
 * ("drop me from Sep 12"), so nothing can compute the new availability from it;
 * the page shows the current availability ticked and the director edits it.
 * Writing the override and recording the decision in one transaction is what
 * stops a half-applied request: an override with nothing marking it done would
 * be silently re-applied by the next director to read the page.
 */
export async function applyAvailabilityChange(
  actorPersonId: string,
  opts: { contractId: string; departmentId: string; dateKeys: string[] },
): Promise<void> {
  await scopeCheck(actorPersonId, opts.departmentId);
  const { row, termId } = await loadOne(opts.contractId, opts.departmentId);

  if (row.decision !== null) {
    throw new AvailabilityRequestValidationError(ALREADY_DECIDED_MESSAGE);
  }
  if (row.membershipId === null) {
    throw new AvailabilityRequestValidationError(NO_MEMBERSHIP_MESSAGE);
  }

  const canonicalDates = await canonicalClinicDates(termId, opts.dateKeys);
  const membershipId = row.membershipId;

  await prisma.$transaction(async (tx) => {
    await tx.termMembership.update({
      where: { id: membershipId },
      data: {
        directorAvailabilityDates: canonicalDates,
        directorAvailabilitySetAt: new Date(),
      },
    });
    await tx.availabilityChangeDecision.create({
      data: {
        contractId: opts.contractId,
        departmentId: opts.departmentId,
        outcome: "APPLIED",
        decidedById: actorPersonId,
      },
    });
  });

  await recordAudit({
    actorPersonId,
    action: "schedule.availability_request_apply",
    entityType: "OnboardingContract",
    entityId: opts.contractId,
    after: {
      departmentId: opts.departmentId,
      membershipId,
      dateKeys: canonicalDates.map(isoDateKey),
    },
  });
}

/**
 * Record the request as handled without changing anything: the director spoke to
 * them, the change was already made, or it cannot be granted.
 *
 * Available for someone not yet on the roster, which applying is not: there is
 * nothing to write for them, but a director must still be able to clear the row.
 */
export async function dismissAvailabilityChange(
  actorPersonId: string,
  opts: { contractId: string; departmentId: string; note?: string },
): Promise<void> {
  await scopeCheck(actorPersonId, opts.departmentId);
  const { row } = await loadOne(opts.contractId, opts.departmentId);

  if (row.decision !== null) {
    throw new AvailabilityRequestValidationError(ALREADY_DECIDED_MESSAGE);
  }

  await prisma.availabilityChangeDecision.create({
    data: {
      contractId: opts.contractId,
      departmentId: opts.departmentId,
      outcome: "DISMISSED",
      note: opts.note?.trim() || null,
      decidedById: actorPersonId,
    },
  });

  await recordAudit({
    actorPersonId,
    action: "schedule.availability_request_dismiss",
    entityType: "OnboardingContract",
    entityId: opts.contractId,
    after: { departmentId: opts.departmentId, note: opts.note?.trim() || null },
  });
}
