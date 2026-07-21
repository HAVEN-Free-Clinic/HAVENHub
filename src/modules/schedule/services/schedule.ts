/**
 * Schedule service for HAVEN Hub.
 *
 * Exposes three operations:
 *   - mySchedule: the caller's shifts, availability, and term context.
 *   - fullSchedule: the clinic-wide schedule view for a selected date.
 *   - updateMyAvailability: structured self-update for the active term.
 *
 * Design note: this service trusts callers for permissions (pages gate). The
 * only invariant enforced here is data validity inside updateMyAvailability.
 */

import type { Department, Term, ShiftRole, ShiftRequest } from "@prisma/client";
import type { ResolvedAvailability } from "../engine/availability";
import { prisma } from "@/platform/db";
import { recordAudit } from "@/platform/audit";
import { getActiveTerm } from "@/platform/terms/active-term";
import { getPersonTerms } from "@/platform/terms/person-terms";
import { resolveAvailability } from "../engine/availability";
import { isoDateKey, toScheduleEntries } from "../engine/map";
import { computeConflicts } from "../engine/conflicts";
import { publishedDepartmentIds } from "./publication";

/** A pending ShiftRequest with the swap target's name included (null for drops). */
export type PendingRequest = ShiftRequest & { target: { name: string } | null };

// ---------------------------------------------------------------------------
// Typed error
// ---------------------------------------------------------------------------

/** Thrown when updateMyAvailability receives invalid input. */
export class AvailabilityValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AvailabilityValidationError";
  }
}

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

export type MyShift = {
  clinicDate: Date;
  department: Department;
  role: ShiftRole;
  tags: { triage: boolean; walkin: boolean; cc: boolean; remote: boolean };
};

export type PersonLite = { id: string; name: string };

/** Department fields the full-schedule view needs (subset of Department). */
export type DepartmentLite = { id: string; name: string; code: string };

export type FullScheduleDepartment = {
  department: DepartmentLite;
  directors: PersonLite[];
  volunteers: Array<PersonLite & { tags: { triage: boolean; walkin: boolean; cc: boolean; remote: boolean } }>;
  shadows: PersonLite[];
  /** Per-person same-day conflict map for the selected date. */
  conflicts: Map<string, string[]>;
};

/** One term's worth of a member's schedule context (see mySchedule). */
export type MyTermSchedule = {
  term: Term;
  isLive: boolean;
  shifts: MyShift[];
  availability: ResolvedAvailability | null;
  legacyNote: string | null;
  clinicDates: Date[];
  pendingRequests: Map<string, PendingRequest>;
};

/**
 * Builds one term's schedule context for a person.
 *
 * Availability is resolved from the person's ACTIVE memberships in the term
 * ordered by department code (first wins; in practice a volunteer is in at
 * most one department per term). Shifts are returned even when no membership
 * is found.
 *
 * pendingRequests is keyed by "${isoDateKey(clinicDate)}|${departmentId}" for
 * each of the person's PENDING requests in the term. Cancelled and approved
 * requests are excluded.
 *
 * For a non-live term, shifts are gated: only assignments in departments that
 * have published their next-term schedule are included. The live term is
 * never gated (members always see their current, running-term shifts).
 */
async function myScheduleForTerm(personId: string, term: Term, isLive: boolean): Promise<MyTermSchedule> {
  const publishedDepts = isLive ? null : await publishedDepartmentIds(term.id);

  // Load shifts and pending requests in parallel.
  const [rawShifts, rawPendingRequests] = await Promise.all([
    prisma.shiftAssignment.findMany({
      where: {
        termId: term.id,
        personId,
        ...(publishedDepts ? { departmentId: { in: [...publishedDepts] } } : {}),
      },
      include: { department: true },
      orderBy: { clinicDate: "asc" },
    }),
    prisma.shiftRequest.findMany({
      where: { termId: term.id, requesterId: personId, status: "PENDING" },
      include: { target: { select: { name: true } } },
    }),
  ]);

  const shifts: MyShift[] = rawShifts.map((s) => ({
    clinicDate: s.clinicDate,
    department: s.department,
    role: s.role,
    tags: { triage: s.triage, walkin: s.walkin, cc: s.cc, remote: s.remote },
  }));

  // Build pendingRequests map keyed by "${dateKey}|${departmentId}".
  const pendingRequests = new Map<string, PendingRequest>();
  for (const req of rawPendingRequests) {
    const key = `${isoDateKey(req.requesterDate)}|${req.departmentId}`;
    pendingRequests.set(key, req);
  }

  // Load ACTIVE memberships in this term, ordered by department code.
  const memberships = await prisma.termMembership.findMany({
    where: { termId: term.id, personId, status: "ACTIVE" },
    include: { department: { select: { code: true } } },
    orderBy: { department: { code: "asc" } },
  });

  let availability: ResolvedAvailability | null = null;
  let legacyNote: string | null = null;

  if (memberships.length > 0) {
    // Use the first membership (ordered by dept code) to build availability tiers.
    const first = memberships[0];
    availability = resolveAvailability({
      baseline: first.baselineAvailability,
      selfDates: first.selfAvailabilityDates,
      selfUpdatedAt: first.availabilityUpdatedAt,
      directorDates: first.directorAvailabilityDates,
      directorSetAt: first.directorAvailabilitySetAt,
    });

    // Legacy free-text note: first non-null across all memberships (dept-code order).
    for (const m of memberships) {
      if (m.selfUpdatedAvailability != null) {
        legacyNote = m.selfUpdatedAvailability;
        break;
      }
    }
  }

  return { term, isLive, shifts, availability, legacyNote, clinicDates: term.clinicDates, pendingRequests };
}

/**
 * Returns the current person's schedule context spanning every term they
 * belong to (their live term plus any next term they are already active in;
 * see getPersonTerms). One entry per term, in getPersonTerms order (live
 * first, then by startDate desc).
 *
 * The live term's entry is never gated: it is the running term, and the
 * member's own shifts in it are always visible to them. A non-live (next)
 * term's entry only includes shifts in departments that have published their
 * schedule for that term; this is the no-leak safety invariant, since a
 * next-term roster can be assembled long before shifts are meant to be seen.
 */
export async function mySchedule(personId: string): Promise<{ terms: MyTermSchedule[] }> {
  const [personTerms, live] = await Promise.all([getPersonTerms(personId), getActiveTerm()]);
  const terms: MyTermSchedule[] = [];
  for (const term of personTerms) {
    terms.push(await myScheduleForTerm(personId, term, term.id === live?.id));
  }
  return { terms };
}

/**
 * Returns the clinic-wide schedule for a selected date.
 *
 * Date selection rules (UTC day keys):
 *   1. If dateKey is provided and matches a term clinicDate, use it.
 *   2. Otherwise pick the first clinicDate >= now (by UTC day key).
 *   3. If all dates are in the past, use the last clinicDate.
 *   4. If no active term, return the all-empty shape.
 *
 * departments contains only departments with assignments on the selected date,
 * sorted by code; the page renders a single empty state when none.
 *
 * No N+1: all ShiftAssignments for the term are loaded in a single query.
 * Conflict maps only include same-day conflicts for the selected date.
 */
export async function fullSchedule(
  dateKey?: string,
  now: Date = new Date()
): Promise<{
  term: Term | null;
  clinicDates: Date[];
  selectedDate: Date | null;
  departments: FullScheduleDepartment[];
}> {
  const term = await getActiveTerm();
  if (!term) {
    return { term: null, clinicDates: [], selectedDate: null, departments: [] };
  }

  const { clinicDates } = term;
  if (clinicDates.length === 0) {
    return { term, clinicDates: [], selectedDate: null, departments: [] };
  }

  // Resolve selected date.
  let selectedDate: Date | null = null;
  if (dateKey) {
    selectedDate = clinicDates.find((d) => isoDateKey(d) === dateKey) ?? null;
  }
  if (!selectedDate) {
    const nowKey = isoDateKey(now);
    selectedDate = clinicDates.find((d) => isoDateKey(d) >= nowKey) ?? clinicDates[clinicDates.length - 1];
  }

  const selectedKey = isoDateKey(selectedDate);

  // Load all shift assignments for the term in one query.
  const allAssignments = await prisma.shiftAssignment.findMany({
    where: { termId: term.id },
    select: {
      personId: true,
      departmentId: true,
      clinicDate: true,
      role: true,
      triage: true,
      walkin: true,
      cc: true,
      remote: true,
      person: { select: { id: true, name: true } },
      department: { select: { id: true, name: true, code: true } },
    },
  });

  // Build engine entries for conflict computation.
  const engineRows = allAssignments.map((a) => ({
    departmentId: a.departmentId,
    departmentName: a.department.name,
    personId: a.personId,
    clinicDate: a.clinicDate,
    role: a.role as "DIRECTOR" | "VOLUNTEER" | "SHADOW",
  }));
  const allEntries = toScheduleEntries(engineRows);

  // Group assignments on the selected date by departmentId, then by role.
  type TaggedPerson = PersonLite & { tags: { triage: boolean; walkin: boolean; cc: boolean; remote: boolean } };

  const selectedAssignments = allAssignments.filter(
    (a) => isoDateKey(a.clinicDate) === selectedKey
  );

  // Departments that have at least one assignment on the selected date, built
  // from the department data already on the assignment rows (no extra query),
  // sorted by code. Plain string comparison is fine for ASCII codes.
  const scheduledDepartments: DepartmentLite[] = [
    ...new Map(selectedAssignments.map((a) => [a.departmentId, a.department])).values(),
  ].sort((a, b) => (a.code < b.code ? -1 : 1));

  // Map departmentId -> lists of people by role.
  const byDept = new Map<string, {
    directors: PersonLite[];
    volunteers: TaggedPerson[];
    shadows: PersonLite[];
  }>();

  for (const dept of scheduledDepartments) {
    byDept.set(dept.id, { directors: [], volunteers: [], shadows: [] });
  }

  for (const a of selectedAssignments) {
    const bucket = byDept.get(a.departmentId);
    if (!bucket) continue;
    const person: PersonLite = { id: a.person.id, name: a.person.name };
    if (a.role === "DIRECTOR") {
      bucket.directors.push(person);
    } else if (a.role === "VOLUNTEER") {
      bucket.volunteers.push({ ...person, tags: { triage: a.triage, walkin: a.walkin, cc: a.cc, remote: a.remote } });
    } else {
      bucket.shadows.push(person);
    }
  }

  // Sort people by name within each group.
  for (const bucket of byDept.values()) {
    bucket.directors.sort((a, b) => a.name.localeCompare(b.name));
    bucket.volunteers.sort((a, b) => a.name.localeCompare(b.name));
    bucket.shadows.sort((a, b) => a.name.localeCompare(b.name));
  }

  // Compute per-department conflict maps for the selected date.
  // Only the sameDay conflicts whose date matches selectedKey are included.
  const departments: FullScheduleDepartment[] = scheduledDepartments.map((dept) => {
    const bucket = byDept.get(dept.id) ?? { directors: [], volunteers: [], shadows: [] };

    // Collect all person ids appearing in this department on the selected date.
    const allPeopleOnDate: PersonLite[] = [
      ...bucket.directors,
      ...bucket.volunteers,
      ...bucket.shadows,
    ];

    const conflicts = new Map<string, string[]>();

    for (const person of allPeopleOnDate) {
      const result = computeConflicts({
        personId: person.id,
        thisDepartmentId: dept.id,
        allSchedule: allEntries,
      });

      // Keep only same-day conflicts for the selected date.
      const otherDeptNames = result.sameDay
        .filter((c) => c.date === selectedKey)
        .map((c) => c.otherDept);

      if (otherDeptNames.length > 0) {
        conflicts.set(person.id, otherDeptNames);
      }
    }

    return {
      department: dept,
      directors: bucket.directors,
      volunteers: bucket.volunteers,
      shadows: bucket.shadows,
      conflicts,
    };
  });

  return { term, clinicDates, selectedDate, departments };
}

/**
 * Updates the actor's self-availability for a given term (their live term or
 * a next term they are already an active member of).
 *
 * Validates that:
 *   - `input.termId` is one of the terms getPersonTerms returns for the actor
 *     (live or next, and the actor holds >= 1 ACTIVE membership in it).
 *   - Every supplied date matches that term's clinicDate by UTC day key.
 *
 * Deduplicates by day key and stores the canonical noon-UTC clinic date
 * objects (from Term.clinicDates) rather than caller-supplied Dates. Updates
 * ALL the actor's ACTIVE memberships in the term atomically. Writes one audit
 * entry with entityType "TermMembership", entityId = first membership id.
 *
 * An empty array is a valid "available never" submission.
 */
export async function updateMyAvailability(
  actorPersonId: string,
  input: { termId: string; dates: Date[]; now?: Date },
): Promise<void> {
  const now = input.now ?? new Date();

  // The term must be one the member is currently an active member of (live or next).
  const terms = await getPersonTerms(actorPersonId);
  const term = terms.find((t) => t.id === input.termId);
  if (!term) {
    throw new AvailabilityValidationError("You are not on that term's roster.");
  }

  const memberships = await prisma.termMembership.findMany({
    where: { termId: term.id, personId: actorPersonId, status: "ACTIVE" },
    orderBy: { id: "asc" },
  });
  if (memberships.length === 0) {
    throw new AvailabilityValidationError("You are not on that term's roster.");
  }

  // Build a map from day key -> canonical clinic date.
  const canonicalByKey = new Map<string, Date>();
  for (const cd of term.clinicDates) {
    canonicalByKey.set(isoDateKey(cd), cd);
  }

  // Deduplicate input by day key.
  const seenKeys = new Set<string>();
  const deduped: string[] = [];
  for (const d of input.dates) {
    const key = isoDateKey(d);
    if (!seenKeys.has(key)) {
      seenKeys.add(key);
      deduped.push(key);
    }
  }

  // Validate: all day keys must be clinic dates.
  const badKeys = deduped.filter((k) => !canonicalByKey.has(k));
  if (badKeys.length > 0) {
    throw new AvailabilityValidationError(
      `The following dates are not clinic dates: ${badKeys.join(", ")}`
    );
  }

  // Resolve canonical dates, sorted ascending. Plain string comparison is
  // correct for zero-padded ISO day keys.
  const canonicalDates = deduped
    .map((k) => canonicalByKey.get(k)!)
    .sort((a, b) => (isoDateKey(a) < isoDateKey(b) ? -1 : 1));

  // Capture before state (ISO day keys from the first membership as representative).
  const beforeDates = memberships[0].selfAvailabilityDates.map(isoDateKey);
  const afterDateKeys = canonicalDates.map(isoDateKey);
  const membershipIds = memberships.map((m) => m.id);

  // Update all ACTIVE memberships atomically.
  await prisma.$transaction(
    memberships.map((m) =>
      prisma.termMembership.update({
        where: { id: m.id },
        data: {
          selfAvailabilityDates: canonicalDates,
          availabilityUpdatedAt: now,
          availabilityAcknowledgedAt: null,
        },
      })
    )
  );

  // One audit entry for the update, entityId = first membership id.
  await recordAudit({
    actorPersonId,
    action: "schedule.availability_update",
    entityType: "TermMembership",
    entityId: memberships[0].id,
    before: { dates: beforeDates },
    after: { dates: afterDateKeys, membershipIds },
  });
}
