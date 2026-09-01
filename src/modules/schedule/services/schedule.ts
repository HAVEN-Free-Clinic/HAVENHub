/**
 * Schedule service for HAVEN Hub.
 *
 * Exposes three operations:
 *   - mySchedule: the caller's shifts, availability, and term context.
 *   - fullSchedule: the clinic-wide schedule view for a selected date.
 *   - updateMyAvailability: structured self-update for a given live or next term.
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
import { resolveAvailability, isAvailabilityLocked } from "../engine/availability";
import { isoDateKey, toScheduleEntries } from "../engine/map";
import { formatForDateInput } from "@/platform/dates/format";
import { getDisplayTimeZone } from "@/platform/dates/resolve";
import { displayTodayKey } from "@/platform/dates/today";
import { spanishScoresByPerson, verifiedLanguagesByPerson } from "@/platform/languages";
import { computeConflicts } from "../engine/conflicts";
import { publishedDepartmentIds } from "./publication";
import { departmentAttendingsForDates } from "@/platform/attendings/coverage";
import { attendanceForDate, type AttendanceRow } from "./attendance";

/** A pending ShiftRequest with the swap target's name included (null for drops). */
export type PendingRequest = ShiftRequest & { target: { name: string } | null };

/**
 * Who is attending FOR each (department, date) the member works.
 *
 * The attending schedule is clinic-wide -- one grid per Saturday with a column
 * per role -- but a member only needs the column that covers THEIR team, which
 * `departmentAttendingsForDates` resolves through the slot-to-department mapping
 * and one hop of DepartmentDelegation. The whole-day picture belongs to the
 * managers' coverage viewer, not to a volunteer's shift card: reading the
 * behavioral health attending's name told a primary care volunteer nothing and
 * invited them to act on it.
 *
 * Keyed "dateKey|departmentId" because one member can hold shifts in two
 * departments on one Saturday and each answers to a different attending.
 *
 * One query per DEPARTMENT rather than per shift, which is at most a handful.
 */
async function attendingsForShifts(
  termId: string,
  shifts: Array<{ clinicDate: Date; departmentId: string }>,
): Promise<Map<string, ShiftAttending[]>> {
  const out = new Map<string, ShiftAttending[]>();
  if (shifts.length === 0) return out;

  const datesByDept = new Map<string, Date[]>();
  for (const s of shifts) {
    datesByDept.set(s.departmentId, [...(datesByDept.get(s.departmentId) ?? []), s.clinicDate]);
  }

  const perDept = await Promise.all(
    [...datesByDept.entries()].map(async ([departmentId, dates]) => ({
      departmentId,
      byDate: await departmentAttendingsForDates(termId, dates, departmentId),
    })),
  );

  for (const { departmentId, byDate } of perDept) {
    for (const [dateKey, rows] of byDate) out.set(`${dateKey}|${departmentId}`, rows);
  }
  return out;
}

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

/** An attending covering a shift, as the member-facing card shows them. */
export type ShiftAttending = {
  name: string;
  /** The schedule column they cover, e.g. "9am-12pm". */
  slotLabel: string;
  startTime: string;
  endTime: string;
};

export type MyShift = {
  clinicDate: Date;
  department: Department;
  role: ShiftRole;
  tags: ShiftTags;
  /**
   * The attending covering THIS shift's department on this date, in
   * schedule-column order.
   *
   * Scoped to the member's own team, not the whole clinic day: the schedule is
   * one clinic-wide grid, but a primary care volunteer needs the primary care
   * columns and nothing else. Resolved through ClinicSlot.departmentId plus one
   * hop of DepartmentDelegation, so SCTP and JCTP read the PCAR columns without
   * being named individually.
   *
   * Empty when nobody is assigned, when the date is closed, when the department
   * maps to no column, or when the only assignment is to a deactivated
   * attending; all of which read as "not announced yet" rather than a gap the
   * member could act on.
   *
   * This is the member-facing answer to "who is my attending on Saturday". The
   * whole day's coverage lives on the managers' coverage viewer, which is gated
   * separately.
   */
  attendings: ShiftAttending[];
};

export type PersonLite = { id: string; name: string };

/** Per-assignment shift flags. Set on EVERY role, not just volunteers: a
 *  director can hold the triage post or work the day remotely just as a
 *  volunteer can, and the full schedule is where the rest of the clinic looks
 *  those up.
 *
 *  `specialty` says this person is covering the day's specialty clinic. Which
 *  specialty that is comes from the day itself, not from here, so there is one
 *  flag rather than one per specialty. It says nothing about being
 *  specialty-trained; that is a person-level credential this deliberately does
 *  not encode. */
export type ShiftTags = {
  triage: boolean;
  walkin: boolean;
  cc: boolean;
  remote: boolean;
  specialty: boolean;
};

export type TaggedPerson = PersonLite & {
  tags: ShiftTags;
  /** Verified language codes, for the capability badges. Never self-reported. */
  verifiedLanguages: string[];
  /**
   * The internal INTP Spanish proficiency score, when one is on record. Drives
   * the badge that tells a director whether this interpreter clears THEIR
   * department bar. Staff-facing only; the schedule is not visible to the
   * volunteer as a page about themselves.
   */
  spanishScore: number | null;
  licensedRN: boolean;
};

/** Department fields the full-schedule view needs (subset of Department). */
export type DepartmentLite = {
  id: string;
  name: string;
  code: string;
  /** This department's interpreting bar; null means the clinic-wide one. */
  minInterpreterScore: number | null;
};

export type FullScheduleDepartment = {
  department: DepartmentLite;
  directors: TaggedPerson[];
  volunteers: TaggedPerson[];
  shadows: TaggedPerson[];
  /** Per-person same-day conflict map for the selected date. */
  conflicts: Map<string, string[]>;
};

/** A department whose availability a director has pinned for this member. Shown
 *  read-only so a pin on one department never hides or shadows the member's
 *  self-availability for their other departments (audit #26 / #61). */
export type DirectorOverride = { departmentId: string; departmentCode: string; dates: Date[] };

/** One term's worth of a member's schedule context (see mySchedule). */
export type MyTermSchedule = {
  term: Term;
  isLive: boolean;
  shifts: MyShift[];
  /** The member's own (self- or baseline-tier) editable availability. Director
   *  overrides are reported separately in directorOverrides and never fold into
   *  this value, so a per-department pin cannot read-only-lock the editable form. */
  availability: ResolvedAvailability | null;
  /** Departments in this term where a director has pinned the member's
   *  availability, in department-code order. Empty when none. */
  directorOverrides: DirectorOverride[];
  /** True when the member holds >= 1 ACTIVE membership and EVERY one is
   *  director-overridden, i.e. nothing they self-enter affects any department's
   *  scheduling. The editable form is withheld in that case. */
  allDepartmentsOverridden: boolean;
  /** True once this term's clinics have started, after which availability is
   *  read-only and changes go through swap/drop requests. See
   *  isAvailabilityLocked. */
  availabilityLocked: boolean;
  legacyNote: string | null;
  clinicDates: Date[];
  pendingRequests: Map<string, PendingRequest>;
};

/**
 * Builds one term's schedule context for a person.
 *
 * The editable `availability` is the member's own SELF/BASELINE resolution
 * (director overrides excluded); self dates are mirrored across all of the
 * member's memberships, so the first (dept-code order) is representative. Each
 * department a director has pinned is reported separately in `directorOverrides`
 * (read-only), and `allDepartmentsOverridden` marks the case where nothing the
 * member self-enters would affect scheduling. This keeps a pin on one department
 * from read-only-locking or silently shadowing the member's other departments
 * (audit #26 / #61). Shifts are returned even when no membership is found.
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
      // Gate pending requests by publish the same way as shifts: an unpublished
      // next-term department contributes no visible shift, so it must not surface
      // a stray pending-request indicator next to the "not published yet" state.
      where: {
        termId: term.id,
        requesterId: personId,
        status: "PENDING",
        ...(publishedDepts ? { departmentId: { in: [...publishedDepts] } } : {}),
      },
      include: { target: { select: { name: true } } },
    }),
  ]);

  const attendingsByShift = await attendingsForShifts(
    term.id,
    rawShifts.map((s) => ({ clinicDate: s.clinicDate, departmentId: s.departmentId })),
  );

  const shifts: MyShift[] = rawShifts.map((s) => ({
    clinicDate: s.clinicDate,
    department: s.department,
    role: s.role,
    tags: { triage: s.triage, walkin: s.walkin, cc: s.cc, remote: s.remote, specialty: s.specialty },
    attendings: attendingsByShift.get(`${isoDateKey(s.clinicDate)}|${s.departmentId}`) ?? [],
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
  const directorOverrides: DirectorOverride[] = [];
  let allDepartmentsOverridden = false;

  if (memberships.length > 0) {
    // The member-editable availability is the SELF/BASELINE resolution only; a
    // director override is NOT folded in here (it is reported separately below),
    // so a pin on one of a multi-department member's memberships can no longer
    // make the whole form read-only (#26) or silently shadow the self-save on
    // their other department (#61). Self dates are mirrored across every
    // membership by updateMyAvailability, so memberships[0] is representative.
    const first = memberships[0];
    availability = resolveAvailability({
      baseline: first.baselineAvailability,
      selfDates: first.selfAvailabilityDates,
      selfUpdatedAt: first.availabilityUpdatedAt,
      directorDates: [],
      directorSetAt: null,
    });

    // Per-department director overrides, in department-code order (memberships
    // are already so ordered). Surfaced read-only on the page.
    for (const m of memberships) {
      if (m.directorAvailabilitySetAt !== null) {
        directorOverrides.push({
          departmentId: m.departmentId,
          departmentCode: m.department.code,
          dates: m.directorAvailabilityDates,
        });
      }
    }
    // Every membership overridden => a self-save would move nothing.
    allDepartmentsOverridden = directorOverrides.length === memberships.length;

    // Legacy free-text note: first non-null across all memberships (dept-code order).
    for (const m of memberships) {
      if (m.selfUpdatedAvailability != null) {
        legacyNote = m.selfUpdatedAvailability;
        break;
      }
    }
  }

  const availabilityLocked = isAvailabilityLocked({
    clinicDateKeys: term.clinicDates.map(isoDateKey),
    todayKey: await displayTodayKey(),
  });

  return { term, isLive, shifts, availability, directorOverrides, allDepartmentsOverridden, availabilityLocked, legacyNote, clinicDates: term.clinicDates, pendingRequests };
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
  // Each term's queries are independent, so resolve them concurrently rather than
  // serially (a member spanning a live and a next term otherwise doubles the wait).
  const terms = await Promise.all(
    personTerms.map((term) => myScheduleForTerm(personId, term, term.id === live?.id)),
  );
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
 * attendance is keyed by personId for the selected date, straight from
 * attendanceForDate. It is NOT filtered by the same active-membership set as
 * departments: a departed member's stray attendance row stays retrievable here
 * rather than being silently dropped, since this function has no way to know
 * whether a caller needs it. In practice the page only looks up attendance for
 * people it already lists (the filtered roster), so a departed member's record
 * is simply never looked up, not incorrectly hidden.
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
  attendance: Map<string, AttendanceRow>;
}> {
  const term = await getActiveTerm();
  if (!term) {
    return { term: null, clinicDates: [], selectedDate: null, departments: [], attendance: new Map() };
  }

  const { clinicDates } = term;
  if (clinicDates.length === 0) {
    return { term, clinicDates: [], selectedDate: null, departments: [], attendance: new Map() };
  }

  // Resolve selected date.
  let selectedDate: Date | null = null;
  if (dateKey) {
    selectedDate = clinicDates.find((d) => isoDateKey(d) === dateKey) ?? null;
  }
  if (!selectedDate) {
    // "Today" must be the display-zone (ET) calendar day, not UTC. Clinic dates
    // are stored at noon UTC so isoDateKey gives their intended calendar day, but
    // a raw isoDateKey(new Date()) rolls over at UTC midnight (~8pm ET), which for
    // the last few hours of every day pushes the default past the current clinic
    // date to the following one. Same fix the dashboard already carries.
    const nowKey = formatForDateInput(now, await getDisplayTimeZone());
    selectedDate = clinicDates.find((d) => isoDateKey(d) >= nowKey) ?? clinicDates[clinicDates.length - 1];
  }

  const selectedKey = isoDateKey(selectedDate);

  // The whole render is one date: the rows, the department list, the language
  // badges, and the only conflicts that survive (same-day ones ON the selected
  // date, see the computeConflicts call below). This used to fetch every
  // assignment in the term and then throw ~13/14ths of them away in memory,
  // which at launch scale (hundreds of volunteers, two shifts each, a ~14-date
  // term) is thousands of rows with two joins read to render one Saturday
  // (audit 14, fullschedule-loads-whole-term).
  //
  // A UTC-day range rather than `clinicDate: selectedDate`, because the filter
  // this replaces compared UTC day KEYS: clinic dates are stored at noon UTC,
  // but an assignment written from an import could carry any time on the day,
  // and equality would silently drop it where the old code kept it.
  const dayStart = new Date(`${selectedKey}T00:00:00.000Z`);
  const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);

  // Attendance for the selected date is independent of the assignment query
  // below, so fetch it concurrently rather than serially.
  const [rawAssignments, attendance] = await Promise.all([
    prisma.shiftAssignment.findMany({
      where: { termId: term.id, clinicDate: { gte: dayStart, lt: dayEnd } },
      select: {
        personId: true,
        departmentId: true,
        clinicDate: true,
        role: true,
        triage: true,
        walkin: true,
        cc: true,
        remote: true,
        specialty: true,
        person: { select: { id: true, name: true, licensedRN: true } },
        department: { select: { id: true, name: true, code: true, minInterpreterScore: true } },
      },
    }),
    attendanceForDate(term.id, selectedDate),
  ]);

  // Offboarding and removeMembership flip a TermMembership to REMOVED but leave
  // the ShiftAssignment rows (by design). This clinic-wide master schedule shows
  // "who is actually working", so drop assignments whose (person, department) is
  // no longer an ACTIVE member of the term, matching who the shift-reminders cron
  // actually notifies. Otherwise a departed person appears as ordinary staff and
  // inflates the hero totals and conflict maps.
  const activeMemberPairs = new Set(
    (await prisma.termMembership.findMany({
      where: { termId: term.id, status: "ACTIVE" },
      select: { personId: true, departmentId: true },
    })).map((m) => `${m.personId}|${m.departmentId}`),
  );
  const selectedAssignments = rawAssignments.filter((a) =>
    activeMemberPairs.has(`${a.personId}|${a.departmentId}`),
  );

  // Build engine entries for conflict computation. One date's worth is enough:
  // computeConflicts only reports a same-day conflict for a date the person is
  // ALSO assigned on in the department being rendered, and its crossTerm list is
  // discarded below, so entries from other dates could never reach the output.
  const engineRows = selectedAssignments.map((a) => ({
    departmentId: a.departmentId,
    departmentName: a.department.name,
    personId: a.personId,
    clinicDate: a.clinicDate,
    role: a.role as "DIRECTOR" | "VOLUNTEER" | "SHADOW",
  }));
  const allEntries = toScheduleEntries(engineRows);

  // Departments that have at least one assignment on the selected date, built
  // from the department data already on the assignment rows (no extra query),
  // sorted by code. Plain string comparison is fine for ASCII codes.
  const scheduledDepartments: DepartmentLite[] = [
    ...new Map(selectedAssignments.map((a) => [a.departmentId, a.department])).values(),
  ].sort((a, b) => (a.code < b.code ? -1 : 1));

  // Map departmentId -> lists of people by role.
  const byDept = new Map<string, {
    directors: TaggedPerson[];
    volunteers: TaggedPerson[];
    shadows: TaggedPerson[];
  }>();

  for (const dept of scheduledDepartments) {
    byDept.set(dept.id, { directors: [], volunteers: [], shadows: [] });
  }

  // Verified language capabilities for everyone on the selected date, in one
  // query. This is what lets a volunteer on shift see who can interpret for a
  // patient without asking around. Verified only: a self-reported claim is not
  // a capability anyone should be relied on for at the point of care.
  const scheduledPersonIds = [...new Set(selectedAssignments.map((a) => a.personId))];
  const [scheduleLanguages, spanishScores] = await Promise.all([
    verifiedLanguagesByPerson(scheduledPersonIds),
    spanishScoresByPerson(scheduledPersonIds),
  ]);

  for (const a of selectedAssignments) {
    const bucket = byDept.get(a.departmentId);
    if (!bucket) continue;
    const person: TaggedPerson = {
      id: a.person.id,
      name: a.person.name,
      tags: { triage: a.triage, walkin: a.walkin, cc: a.cc, remote: a.remote, specialty: a.specialty },
      verifiedLanguages: scheduleLanguages.get(a.personId) ?? [],
      spanishScore: spanishScores.get(a.personId) ?? null,
      licensedRN: a.person.licensedRN,
    };
    if (a.role === "DIRECTOR") {
      bucket.directors.push(person);
    } else if (a.role === "VOLUNTEER") {
      bucket.volunteers.push(person);
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
    const allPeopleOnDate: TaggedPerson[] = [
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

  return { term, clinicDates, selectedDate, departments, attendance };
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

  // A term with no clinic dates has no availability to record. Refuse rather than
  // accept the empty submission the page would post from an empty checkbox grid:
  // writing selfAvailabilityDates: [] + availabilityUpdatedAt promotes an empty
  // SELF tier over the application BASELINE, so once the calendar is repopulated
  // the member reads as available on no date and their application answers are
  // unrecoverable (#90). The page suppresses the form in this state; this is the
  // server-side backstop against a stale tab or crafted post.
  if (term.clinicDates.length === 0) {
    throw new AvailabilityValidationError("Clinic dates for this term have not been set yet.");
  }

  // Availability closes when the term's clinics start. After that the published
  // schedule is live, so changes must go through the swap/drop request flow
  // (director approval, partner notified) rather than a silent edit here. The
  // page hides the form once locked; this is the server-side backstop against a
  // stale tab or a crafted post.
  if (
    isAvailabilityLocked({
      clinicDateKeys: term.clinicDates.map(isoDateKey),
      todayKey: await displayTodayKey(now),
    })
  ) {
    throw new AvailabilityValidationError(
      "Availability is locked for this term because clinics have started. Submit a swap or drop request for the shift you need to change.",
    );
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
