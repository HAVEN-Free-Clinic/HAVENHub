/**
 * Builder service for HAVEN Hub's schedule builder page.
 *
 * Scope is enforced internally per mutation: every write checks that the
 * actor's manageable department set includes the target department before
 * touching any data. builderView trusts the caller for page-level gating
 * but scopes its data to the viewer's manageable departments.
 *
 * Typed errors: BuilderForbiddenError, BuilderValidationError.
 */

import type { ClinicDay, Term } from "@prisma/client";
import { prisma } from "@/platform/db";
import { recordAudit } from "@/platform/audit";
import { isoDateKey } from "@/platform/dates";
import { displayTodayKey } from "@/platform/dates/today";
import { manageableDepartmentIds } from "@/platform/departments";
import { verifiedLanguagesByPerson } from "@/platform/languages";
import { can, permissionDepartmentIds } from "@/platform/rbac/engine";
import { loadClearanceMap } from "@/platform/clearance";
import { resolveAvailability } from "../engine/availability";
import type { ResolvedAvailability } from "../engine/availability";
import { toScheduleEntries } from "../engine/map";
import type { ShiftTags } from "./schedule";
import { computeConflicts } from "../engine/conflicts";
import { computeDayMetrics } from "../engine/capacity";
import type { DayMetrics } from "../engine/capacity";
import { summarizeNotCleared } from "../engine/banner";
import type { DeptBanner } from "../engine/banner";
import { computeClinicReadiness, PROCEDURE_KEYS } from "../engine/rhd";
import type {
  ClinicReadiness,
  RhdPersonLite,
  ReadinessAttending,
  ProcedureKey,
  ProcedureStatus,
} from "../engine/rhd";
import { getSetting } from "@/platform/settings/service";

// ---------------------------------------------------------------------------
// Typed errors
// ---------------------------------------------------------------------------

/** Actor lacks permission to manage the target department. */
export class BuilderForbiddenError extends Error {
  constructor(message = "Forbidden") {
    super(message);
    this.name = "BuilderForbiddenError";
  }
}

/** Input is invalid or violates schedule invariants. */
export class BuilderValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BuilderValidationError";
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ARCHIVED_TERM_MESSAGE = "This term is archived and read-only.";

/**
 * Load the term a builder write targets, rejecting a missing term or an
 * ARCHIVED (read-only) term. This is the server-side enforcement of the
 * archived-is-read-only rule: even a stale tab or crafted request cannot mutate
 * a closed term's schedule.
 */
async function loadEditableTerm(termId: string): Promise<Term> {
  const term = await prisma.term.findUnique({ where: { id: termId } });
  if (!term) throw new BuilderValidationError("Unknown term.");
  if (term.status === "ARCHIVED") throw new BuilderValidationError(ARCHIVED_TERM_MESSAGE);
  return term;
}

// ---------------------------------------------------------------------------
// RHD department codes
// ---------------------------------------------------------------------------

export const RHD_CODES = new Set(["SCTS", "JCTS", "CCRH"]);

/**
 * Which columns of the clinic-wide attending schedule staff reproductive health.
 *
 * The readiness panel is about procedure coverage, so it must count the RHD
 * attending and nobody else: the 9am-12pm primary care attendings are on the
 * same clinic day but do not make an IUD bookable.
 *
 * Matched by LABEL because the slot list is Faculty Relations' to edit; renaming
 * the column here is the deliberate way to re-point the panel.
 */
export const RHD_SLOT_LABELS = new Set(["RHD Attending"]);

// ---------------------------------------------------------------------------
// Input allow-lists
// ---------------------------------------------------------------------------

/**
 * Roles a scheduler may assign (mirrors the ShiftRole DB enum). The action
 * reads `role` from FormData with a bare cast, so the service re-checks the
 * value against this allow-list before any write -- a crafted out-of-set value
 * raises BuilderValidationError (the friendly path) instead of letting the DB
 * throw an opaque PrismaClientValidationError.
 */
export const SHIFT_ROLES = ["VOLUNTEER", "SHADOW", "DIRECTOR"] as const;

/**
 * Boolean tag columns toggleable on a ShiftAssignment. Guarded the same way as
 * SHIFT_ROLES so a bad `tag` never reaches `data: { [tag]: value }`.
 *
 * `specialty` marks an assignment as covering the day's specialty clinic. WHICH
 * specialty is running belongs to the day (ClinicDay.specialtyId), so this is one
 * flag rather than one per specialty.
 */
export const SHIFT_TAGS = ["triage", "walkin", "cc", "remote", "specialty"] as const;

/**
 * Derived from SHIFT_TAGS rather than retyped. toggleTag used to spell the union
 * out separately, so adding a column meant remembering to edit both, and the
 * allow-list could silently disagree with the type it was guarding.
 */
export type ShiftTag = (typeof SHIFT_TAGS)[number];

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Validates that the actor may manage the given departmentId.
 * Throws BuilderForbiddenError when not.
 */
async function scopeCheck(actorPersonId: string, departmentId: string): Promise<void> {
  const manageable = await manageableScheduleDepartmentIds(actorPersonId);
  if (!manageable.includes(departmentId)) {
    throw new BuilderForbiddenError();
  }
}

// ---------------------------------------------------------------------------
// Scoping helper (exported for tests)
// ---------------------------------------------------------------------------

/**
 * Returns the set of department ids the person may manage for schedule
 * purposes: manageableDepartmentIds(personId) UNION
 * permissionDepartmentIds(personId, "schedule.edit_own_dept") UNION (when
 * can(personId, "schedule.edit_all")) ALL department ids. Deduped.
 *
 * The edit_own_dept branch is scoped to the departments the grant was actually
 * made through, not to every department the person belongs to: someone who
 * directs one department and volunteers in another must not edit the schedule of
 * the one they merely volunteer in.
 */
export async function manageableScheduleDepartmentIds(personId: string): Promise<string[]> {
  const [base, editOwnDeptIds, editAll] = await Promise.all([
    manageableDepartmentIds(personId),
    permissionDepartmentIds(personId, "schedule.edit_own_dept"),
    can(personId, "schedule.edit_all"),
  ]);

  const ids = new Set<string>(base);

  // edit_own_dept: extend to the departments that grant reaches.
  for (const id of editOwnDeptIds) ids.add(id);

  // edit_all: union with every department in the DB.
  if (editAll) {
    const all = await prisma.department.findMany({ select: { id: true } });
    for (const d of all) ids.add(d.id);
  }

  return [...ids];
}

/**
 * True when the person can use the Builder at all -- i.e. manages at least one
 * schedule department (a directorship, a delegation, or schedule.edit_all).
 * Plain schedule.view holders get false. Drives both the Builder nav tab
 * visibility and the page gate so the tab is never a render-but-do-nothing
 * dead end for a non-manager.
 */
export async function canManageAnyScheduleDept(personId: string): Promise<boolean> {
  return (await manageableScheduleDepartmentIds(personId)).length > 0;
}

/**
 * Assigns or unassigns a person to a clinic date in a department.
 *
 * role "VOLUNTEER" | "SHADOW" | "DIRECTOR": upsert on the unique key.
 *   - Create: all tags false.
 *   - Update: role only (existing tags preserved).
 * role null: delete the row (tags die with it). Reason captured in audit.
 *
 * Validation:
 *   - dateKey must be a clinic date in the active term.
 *   - person must have an ACTIVE membership in the department+term.
 *   - role DIRECTOR only allowed when membership.kind === "DIRECTOR".
 */
export async function setAssignment(
  actor: string,
  opts: {
    termId: string;
    departmentId: string;
    dateKey: string;
    personId: string;
    role: "VOLUNTEER" | "SHADOW" | "DIRECTOR" | null;
    reason?: string;
  }
): Promise<void> {
  await scopeCheck(actor, opts.departmentId);

  // Reject a role outside the allow-list before any DB work. role === null is the
  // valid unassign case.
  if (opts.role !== null && !SHIFT_ROLES.includes(opts.role)) {
    throw new BuilderValidationError("Invalid role.");
  }

  const term = await loadEditableTerm(opts.termId);

  if (opts.role !== null) {
    // Assign: the date must be an active clinic date of the term. (Unassign
    // resolves the row by day key below instead, so an assignment left on a date
    // that updateClinicDates later removed can still be cleared -- #58.)
    const clinicDate = term.clinicDates.find((d) => isoDateKey(d) === opts.dateKey);
    if (!clinicDate) {
      throw new BuilderValidationError(`${opts.dateKey} is not a clinic date in the selected term.`);
    }

    // Validate membership.
    const membership = await prisma.termMembership.findFirst({
      where: {
        termId: term.id,
        departmentId: opts.departmentId,
        personId: opts.personId,
        status: "ACTIVE",
      },
    });
    if (!membership) {
      throw new BuilderValidationError(
        "Person does not have an active membership in this department for the current term."
      );
    }

    // Director role requires director-kind membership.
    if (opts.role === "DIRECTOR" && membership.kind !== "DIRECTOR") {
      throw new BuilderValidationError(
        "DIRECTOR role may only be assigned to members with a DIRECTOR membership kind."
      );
    }

    await prisma.shiftAssignment.upsert({
      where: {
        termId_departmentId_clinicDate_personId: {
          termId: term.id,
          departmentId: opts.departmentId,
          clinicDate,
          personId: opts.personId,
        },
      },
      create: {
        termId: term.id,
        departmentId: opts.departmentId,
        clinicDate,
        personId: opts.personId,
        role: opts.role,
        triage: false,
        walkin: false,
        cc: false,
        remote: false,
      },
      update: { role: opts.role },
    });

    await recordAudit({
      actorPersonId: actor,
      action: "schedule.assign",
      entityType: "ShiftAssignment",
      entityId: `${term.id}|${opts.departmentId}|${opts.dateKey}|${opts.personId}`,
      after: { role: opts.role, dateKey: opts.dateKey, personId: opts.personId },
    });
  } else {
    // Unassign: resolve the row by its day key rather than requiring the date to
    // still be an active clinic date (#58). updateClinicDates can drop a clinic
    // date without deleting ShiftAssignment rows, and the Builder only renders
    // active clinic dates, so an assignment stranded on a removed date would
    // otherwise be unremovable by anyone through the UI.
    const candidates = await prisma.shiftAssignment.findMany({
      where: { termId: term.id, departmentId: opts.departmentId, personId: opts.personId },
      select: { id: true, clinicDate: true, role: true },
    });
    const existing = candidates.find((row) => isoDateKey(row.clinicDate) === opts.dateKey);

    if (existing) {
      await prisma.shiftAssignment.delete({ where: { id: existing.id } });
    }

    // Auto-cancel any PENDING drop/swap request the person raised for THIS slot.
    // Once their assignment here is gone the request is orphaned: /schedule only
    // renders (and offers Cancel for) a request that still has a matching shift
    // card, so without this the requester is stuck showing "Pending requests: 1"
    // with no card and no Cancel control, approveRequest would fail validation
    // ("Not assigned to that shift"), and the schedule-reminders cron keeps
    // nagging the department's approvers every few days (#25). Matching is by UTC
    // day key so a request on a clinic date updateClinicDates later removed is
    // still cleared. The status: "PENDING" precondition on the write makes this a
    // no-op against a request an approver is concurrently deciding.
    const openRequests = await prisma.shiftRequest.findMany({
      where: {
        termId: term.id,
        departmentId: opts.departmentId,
        requesterId: opts.personId,
        status: "PENDING",
      },
      select: { id: true, requesterDate: true },
    });
    const strandedIds = openRequests
      .filter((r) => isoDateKey(r.requesterDate) === opts.dateKey)
      .map((r) => r.id);
    if (strandedIds.length > 0) {
      await prisma.shiftRequest.updateMany({
        where: { id: { in: strandedIds }, status: "PENDING" },
        data: { status: "CANCELLED" },
      });
    }

    await recordAudit({
      actorPersonId: actor,
      action: "schedule.unassign",
      entityType: "ShiftAssignment",
      entityId: `${term.id}|${opts.departmentId}|${opts.dateKey}|${opts.personId}`,
      before: {
        role: existing?.role ?? null,
        dateKey: opts.dateKey,
        personId: opts.personId,
        reason: opts.reason ?? null,
      },
    });
  }
}

/**
 * Flips one of the SHIFT_TAGS booleans on an existing assignment.
 *
 * Throws BuilderValidationError when no assignment row exists for the
 * person/date/department combination.
 */
export async function toggleTag(
  actor: string,
  opts: {
    termId: string;
    departmentId: string;
    dateKey: string;
    personId: string;
    tag: ShiftTag;
  }
): Promise<void> {
  await scopeCheck(actor, opts.departmentId);

  // Reject a tag outside the allow-list before it can reach `data: { [tag]: ... }`.
  if (!SHIFT_TAGS.includes(opts.tag)) {
    throw new BuilderValidationError("Invalid tag.");
  }

  const term = await loadEditableTerm(opts.termId);

  const clinicDate = term.clinicDates.find((d) => isoDateKey(d) === opts.dateKey);
  if (!clinicDate) {
    throw new BuilderValidationError(`${opts.dateKey} is not a clinic date in the selected term.`);
  }

  const existing = await prisma.shiftAssignment.findFirst({
    where: {
      termId: term.id,
      departmentId: opts.departmentId,
      clinicDate,
      personId: opts.personId,
    },
  });
  if (!existing) {
    throw new BuilderValidationError("No assignment row found for this person/date/department.");
  }

  const newValue = !existing[opts.tag];
  await prisma.shiftAssignment.update({
    where: { id: existing.id },
    data: { [opts.tag]: newValue },
  });

  await recordAudit({
    actorPersonId: actor,
    action: "schedule.tag",
    entityType: "ShiftAssignment",
    entityId: existing.id,
    before: { [opts.tag]: existing[opts.tag] },
    after: { [opts.tag]: newValue },
  });
}

/**
 * Upserts the patientsBooked field on the ScheduleDay row for a
 * (term, department, date) triple. A null value clears the field.
 */
export async function setPatientsBooked(
  actor: string,
  opts: { termId: string; departmentId: string; dateKey: string; patientsBooked: number | null }
): Promise<void> {
  await scopeCheck(actor, opts.departmentId);

  const term = await loadEditableTerm(opts.termId);

  const clinicDate = term.clinicDates.find((d) => isoDateKey(d) === opts.dateKey);
  if (!clinicDate) {
    throw new BuilderValidationError(`${opts.dateKey} is not a clinic date in the selected term.`);
  }

  const scheduleDayBefore = await prisma.scheduleDay.findFirst({
    where: { termId: term.id, departmentId: opts.departmentId, clinicDate },
  });

  await prisma.scheduleDay.upsert({
    where: {
      termId_departmentId_clinicDate: {
        termId: term.id,
        departmentId: opts.departmentId,
        clinicDate,
      },
    },
    create: {
      termId: term.id,
      departmentId: opts.departmentId,
      clinicDate,
      patientsBooked: opts.patientsBooked,
    },
    update: { patientsBooked: opts.patientsBooked },
  });

  await recordAudit({
    actorPersonId: actor,
    action: "schedule.patients_booked",
    entityType: "ScheduleDay",
    entityId: `${term.id}|${opts.departmentId}|${opts.dateKey}`,
    before: { patientsBooked: scheduleDayBefore?.patientsBooked ?? null },
    after: { patientsBooked: opts.patientsBooked },
  });
}

/**
 * Sets or clears `proceduresBooked` on the clinic-wide ClinicDay row, from the
 * RHD readiness panel in the builder.
 *
 * Scoped to the reproductive health department the panel is rendered for, NOT to
 * schedule.manage_attendings the way {@link upsertClinicDay} is. The number is
 * the reproductive health director's to keep; it only ever lived on the
 * attending form because that form owned the whole ClinicDay row. The attending
 * schedule no longer offers the field, so this is its one writer.
 *
 * The department is re-derived and checked against RHD_CODES rather than trusted
 * from the form: the row this writes is clinic-wide, so without that check the
 * director of ANY department the actor manages could set the reproductive health
 * number by posting their own departmentId.
 */
export async function setProceduresBooked(
  actor: string,
  opts: { termId: string; departmentId: string; dateKey: string; proceduresBooked: number | null }
): Promise<void> {
  await scopeCheck(actor, opts.departmentId);

  const dept = await prisma.department.findUnique({
    where: { id: opts.departmentId },
    select: { code: true },
  });
  if (!dept || !RHD_CODES.has(dept.code)) {
    throw new BuilderForbiddenError(
      "Procedures booked is set from the reproductive health schedule.",
    );
  }

  const term = await loadEditableTerm(opts.termId);
  const clinicDate = term.clinicDates.find((d) => isoDateKey(d) === opts.dateKey);
  if (!clinicDate) {
    throw new BuilderValidationError(`${opts.dateKey} is not a clinic date in the selected term.`);
  }

  const before = await prisma.clinicDay.findUnique({
    where: { termId_clinicDate: { termId: term.id, clinicDate } },
    select: { proceduresBooked: true },
  });

  await prisma.clinicDay.upsert({
    where: { termId_clinicDate: { termId: term.id, clinicDate } },
    create: { termId: term.id, clinicDate, proceduresBooked: opts.proceduresBooked },
    update: { proceduresBooked: opts.proceduresBooked },
  });

  await recordAudit({
    actorPersonId: actor,
    action: "schedule.procedures_booked",
    entityType: "ClinicDay",
    entityId: `${term.id}|${opts.dateKey}`,
    before: { proceduresBooked: before?.proceduresBooked ?? null },
    after: { proceduresBooked: opts.proceduresBooked },
  });
}

/**
 * Sets or clears the director availability override for a membership.
 *
 * dateKeys non-null: validates each is a clinic date, stores canonical
 * clinic Date objects as directorAvailabilityDates and sets
 * directorAvailabilitySetAt = now.
 * dateKeys null: clears (directorAvailabilityDates = [],
 * directorAvailabilitySetAt = null).
 *
 * The membership must be in a department the actor manages.
 */
export async function setAvailabilityOverride(
  actor: string,
  opts: { membershipId: string; dateKeys: string[] | null }
): Promise<void> {
  const membership = await prisma.termMembership.findUnique({
    where: { id: opts.membershipId },
    include: { term: true },
  });
  if (!membership) throw new BuilderValidationError("Membership not found.");

  await scopeCheck(actor, membership.departmentId);

  if (membership.term.status === "ARCHIVED") {
    throw new BuilderValidationError(ARCHIVED_TERM_MESSAGE);
  }

  if (opts.dateKeys !== null) {
    const canonicalByKey = new Map<string, Date>();
    for (const d of membership.term.clinicDates) {
      canonicalByKey.set(isoDateKey(d), d);
    }

    const badKeys = opts.dateKeys.filter((k) => !canonicalByKey.has(k));
    if (badKeys.length > 0) {
      throw new BuilderValidationError(
        `The following dates are not clinic dates: ${badKeys.join(", ")}`
      );
    }

    const canonicalDates = opts.dateKeys
      .map((k) => canonicalByKey.get(k)!)
      .sort((a, b) => (isoDateKey(a) < isoDateKey(b) ? -1 : 1));

    await prisma.termMembership.update({
      where: { id: opts.membershipId },
      data: {
        directorAvailabilityDates: canonicalDates,
        directorAvailabilitySetAt: new Date(),
      },
    });
  } else {
    await prisma.termMembership.update({
      where: { id: opts.membershipId },
      data: {
        directorAvailabilityDates: [],
        directorAvailabilitySetAt: null,
      },
    });
  }

  await recordAudit({
    actorPersonId: actor,
    action: "schedule.availability_override",
    entityType: "TermMembership",
    entityId: opts.membershipId,
    after: { dateKeys: opts.dateKeys },
  });
}

/**
 * Stamps availabilityAcknowledgedAt = now on the membership.
 * The membership must be in a department the actor manages.
 */
export async function acknowledgeAvailability(
  actor: string,
  membershipId: string
): Promise<void> {
  const membership = await prisma.termMembership.findUnique({
    where: { id: membershipId },
  });
  if (!membership) throw new BuilderValidationError("Membership not found.");

  await scopeCheck(actor, membership.departmentId);

  await prisma.termMembership.update({
    where: { id: membershipId },
    data: { availabilityAcknowledgedAt: new Date() },
  });

  await recordAudit({
    actorPersonId: actor,
    action: "schedule.availability_acknowledge",
    entityType: "TermMembership",
    entityId: membershipId,
  });
}

/**
 * Parse a booked-count field ("" -> null, else a non-negative integer).
 *
 * Throws BuilderValidationError, which runAction turns into an inline error
 * rather than a 500, so call it inside an action's `work` closure. Shared by the
 * builder's patients-booked and the RHD readiness panel's procedures-booked,
 * which must reject the same inputs -- a negative or fractional count reaching
 * the column would make the readiness cap warning silently wrong.
 */
export function parseBookedCount(raw: string, label: string): number | null {
  if (raw.trim() === "") return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    throw new BuilderValidationError(`${label} must be a whole number of 0 or more.`);
  }
  return n;
}

/**
 * A YYYY-MM-DD key as the noon-UTC instant clinic dates are anchored at, or null
 * when the key is not a real calendar date.
 *
 * Noon, not midnight, so the row lands on the same instant a later term-calendar
 * edit would produce for the same day -- otherwise adding the date to the term
 * would create a SECOND ClinicDay beside the on-call one.
 */
function dateKeyToNoonUtc(key: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) return null;
  const d = new Date(`${key}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  // Round-trip check: JS normalizes impossible dates (2026-02-30) into a valid
  // day in the next month rather than returning NaN.
  return d.toISOString().slice(0, 10) === key ? d : null;
}

/** Whether a date falls inside the term's calendar window, inclusive. */
function withinTerm(d: Date, term: { startDate: Date; endDate: Date }): boolean {
  const key = isoDateKey(d);
  return key >= isoDateKey(term.startDate) && key <= isoDateKey(term.endDate);
}

/**
 * Upserts one clinic date of the clinic-wide attending schedule.
 *
 * Requires schedule.manage_attendings: there is ONE schedule for the whole
 * clinic, maintained by Faculty Relations. This used to be scoped to the
 * director of a "service line", which was the wrong shape -- attendings belong
 * to no department, and reproductive health and primary care are columns of one
 * grid rather than separate schedules.
 *
 * Every field is optional and only what is passed gets written, so the grid can
 * save one cell without disturbing the rest of the row.
 *
 * The dateKey must fall inside the term. A date the term does not list as a
 * clinic date is accepted for the ON-CALL attending alone: on call covers the
 * week leading up to the next clinic day, so someone holds the pager across a
 * break week even though the clinic itself does not run. Everything else on such
 * a date is refused rather than silently dropped -- the builder shows those
 * dates closed, and a slot assignment reaching here means the caller disagrees
 * with what the manager was shown.
 */
export async function upsertClinicDay(
  actor: string,
  opts: {
    termId: string;
    dateKey: string;
    /**
     * Slot id -> the attendings covering it. An EMPTY array unstaffs that slot.
     * Only the slots present here are touched; omitting the field entirely (a
     * director-name-only save) leaves every assignment standing.
     */
    attendingsBySlot?: Record<string, string[]>;
    onCallAttendingId?: string | null;
    specialtyId?: string | null;
    isClosed?: boolean;
    closedNote?: string | null;
    directorName?: string | null;
    proceduresBooked?: number | null;
  }
): Promise<void> {
  if (!(await can(actor, "schedule.manage_attendings"))) {
    throw new BuilderForbiddenError("You do not manage the attending schedule.");
  }

  const term = await loadEditableTerm(opts.termId);
  const listed = term.clinicDates.find((d) => isoDateKey(d) === opts.dateKey);

  // A date the term does not list still gets a row when it carries on call, so
  // resolve it from the key itself. Noon UTC matches how clinic dates are
  // anchored, so the (term, date) unique key lands on the same instant a later
  // calendar edit would produce.
  const clinicDate = listed ?? dateKeyToNoonUtc(opts.dateKey);
  if (!clinicDate) {
    throw new BuilderValidationError(`${opts.dateKey} is not a valid date.`);
  }
  if (!listed) {
    if (!withinTerm(clinicDate, term)) {
      throw new BuilderValidationError(`${opts.dateKey} falls outside ${term.name}.`);
    }
    // On call is the one field a non-clinic date carries. `isClosed` is allowed
    // through only as `true`, which is what the builder already renders for such
    // a date -- accepting `false` would let a save contradict it.
    const assignsSlots = Object.values(opts.attendingsBySlot ?? {}).some((ids) => ids.length > 0);
    const setsDayFields =
      assignsSlots ||
      (opts.specialtyId ?? null) !== null ||
      (opts.directorName ?? null) !== null ||
      (opts.proceduresBooked ?? null) !== null ||
      ("isClosed" in opts && opts.isClosed === false);
    if (setsDayFields) {
      throw new BuilderValidationError(
        `${opts.dateKey} is not a clinic date in ${term.name}, so only the on-call attending can be set.`,
      );
    }
  }

  // Slot ids, attending ids and the specialty are foreign keys read verbatim
  // from FormData. Validate before the write so a stale or tampered id surfaces
  // a friendly validation error rather than a raw Prisma P2003 that runAction
  // rethrows as a 500.
  const assignments = await resolveSlotAssignments(opts.attendingsBySlot);
  if (opts.onCallAttendingId) await assertAttendingExists(opts.onCallAttendingId, "on-call attending");
  if (opts.specialtyId) {
    const specialty = await prisma.attendingSpecialty.findUnique({
      where: { id: opts.specialtyId },
      select: { runsSpecialtyClinic: true },
    });
    if (!specialty) throw new BuilderValidationError("That specialty no longer exists.");
    if (!specialty.runsSpecialtyClinic) {
      throw new BuilderValidationError("That specialty does not run a specialty clinic.");
    }
  }

  const dayFields = {
    ...("onCallAttendingId" in opts && { onCallAttendingId: opts.onCallAttendingId ?? null }),
    ...("specialtyId" in opts && { specialtyId: opts.specialtyId ?? null }),
    ...("isClosed" in opts && { isClosed: opts.isClosed ?? false }),
    ...("closedNote" in opts && { closedNote: opts.closedNote ?? null }),
    ...("directorName" in opts && { directorName: opts.directorName ?? null }),
    ...("proceduresBooked" in opts && { proceduresBooked: opts.proceduresBooked ?? null }),
    // A date the term does not list is closed as a fact, not a setting. Written
    // rather than left derived because readers that go straight to ClinicDay --
    // the member shift card, the reminder emails -- filter on this column and
    // would otherwise treat an on-call-only row as an open clinic day.
    ...(listed ? {} : { isClosed: true }),
  };

  const before = await prisma.clinicDay.findUnique({
    where: { termId_clinicDate: { termId: term.id, clinicDate } },
    select: auditSelect,
  });

  // One transaction: a cell save is one edit to the reader, so a per-day field
  // must not land while its slot assignments fail, or vice versa.
  const after = await prisma.$transaction(async (tx) => {
    const day = await tx.clinicDay.upsert({
      where: { termId_clinicDate: { termId: term.id, clinicDate } },
      create: { termId: term.id, clinicDate, ...dayFields },
      update: dayFields,
      select: { id: true },
    });

    if (assignments) {
      for (const { slotId, attendingIds } of assignments) {
        // Replace-set per slot: the cell posts everyone it shows, so removing a
        // name from the cell must delete that row rather than merge.
        await tx.clinicDayAttending.deleteMany({ where: { clinicDayId: day.id, slotId } });
        if (attendingIds.length > 0) {
          await tx.clinicDayAttending.createMany({
            data: attendingIds.map((attendingId, order) => ({
              clinicDayId: day.id,
              slotId,
              attendingId,
              order,
            })),
          });
        }
      }
    }

    return tx.clinicDay.findUniqueOrThrow({ where: { id: day.id }, select: auditSelect });
  });

  await recordAudit({
    actorPersonId: actor,
    action: "schedule.clinic_day",
    entityType: "ClinicDay",
    entityId: `${term.id}|${opts.dateKey}`,
    ...(before && { before: auditShape(before) }),
    after: auditShape(after),
  });
}

/**
 * Add or remove ONE attending in one slot of one clinic date.
 *
 * The grid's cell toggle. Separate from {@link upsertClinicDay}, whose
 * `attendingsBySlot` is a replace-set: a grid cell knows only about itself, and
 * making it post the slot's whole contents would mean a stale page silently
 * unassigning the colleague someone else added while it was open.
 *
 * Slot assignment is refused on a date the term does not list as a clinic date,
 * matching what the builder renders for such a date -- it is closed, and only
 * the on-call attending crosses that line.
 */
export async function setSlotAttending(
  actor: string,
  opts: {
    termId: string;
    dateKey: string;
    slotId: string;
    attendingId: string;
    /** True to put them in the slot, false to take them out. */
    assigned: boolean;
  },
): Promise<void> {
  if (!(await can(actor, "schedule.manage_attendings"))) {
    throw new BuilderForbiddenError("You do not manage the attending schedule.");
  }

  const term = await loadEditableTerm(opts.termId);
  const clinicDate = term.clinicDates.find((d) => isoDateKey(d) === opts.dateKey);
  if (!clinicDate) {
    throw new BuilderValidationError(`${opts.dateKey} is not a clinic date in ${term.name}.`);
  }

  // Both ids arrive verbatim from a form. Validate before the write so a stale
  // or tampered id surfaces a friendly error rather than a raw Prisma P2003.
  const slot = await prisma.clinicSlot.findUnique({
    where: { id: opts.slotId },
    select: { id: true, label: true, allowsMultiple: true },
  });
  if (!slot) throw new BuilderValidationError("That schedule column no longer exists.");
  await assertAttendingExists(opts.attendingId, "attending");

  const before = await prisma.clinicDay.findUnique({
    where: { termId_clinicDate: { termId: term.id, clinicDate } },
    select: auditSelect,
  });

  const after = await prisma.$transaction(async (tx) => {
    const day = await tx.clinicDay.upsert({
      where: { termId_clinicDate: { termId: term.id, clinicDate } },
      create: { termId: term.id, clinicDate },
      update: {},
      select: { id: true },
    });

    if (!opts.assigned) {
      await tx.clinicDayAttending.deleteMany({
        where: { clinicDayId: day.id, slotId: slot.id, attendingId: opts.attendingId },
      });
      return tx.clinicDay.findUniqueOrThrow({ where: { id: day.id }, select: auditSelect });
    }

    // A single-attending column holds one person, so assigning REPLACES whoever
    // is there. The grid shows that column's occupant in the cell, so the
    // manager can see what they are displacing before they click.
    if (!slot.allowsMultiple) {
      await tx.clinicDayAttending.deleteMany({ where: { clinicDayId: day.id, slotId: slot.id } });
    }

    const existing = await tx.clinicDayAttending.count({
      where: { clinicDayId: day.id, slotId: slot.id },
    });
    // Idempotent on the unique (day, slot, attending): clicking twice, or two
    // managers clicking at once, must not 500 on a duplicate key.
    await tx.clinicDayAttending.upsert({
      where: {
        clinicDayId_slotId_attendingId: {
          clinicDayId: day.id,
          slotId: slot.id,
          attendingId: opts.attendingId,
        },
      },
      create: {
        clinicDayId: day.id,
        slotId: slot.id,
        attendingId: opts.attendingId,
        order: existing,
      },
      update: {},
    });

    return tx.clinicDay.findUniqueOrThrow({ where: { id: day.id }, select: auditSelect });
  });

  await recordAudit({
    actorPersonId: actor,
    action: "schedule.clinic_day",
    entityType: "ClinicDay",
    entityId: `${term.id}|${opts.dateKey}`,
    ...(before && { before: auditShape(before) }),
    after: auditShape(after),
  });
}

/** What the audit trail records about a clinic day, before and after. */
const auditSelect = {
  isClosed: true,
  closedNote: true,
  onCallAttendingId: true,
  specialtyId: true,
  directorName: true,
  proceduresBooked: true,
  attendings: { select: { slotId: true, attendingId: true, order: true } },
} as const;

type AuditRow = {
  isClosed: boolean;
  closedNote: string | null;
  onCallAttendingId: string | null;
  specialtyId: string | null;
  directorName: string | null;
  proceduresBooked: number | null;
  attendings: Array<{ slotId: string; attendingId: string; order: number }>;
};

function auditShape(r: AuditRow) {
  return {
    isClosed: r.isClosed,
    closedNote: r.closedNote,
    onCallAttendingId: r.onCallAttendingId,
    specialtyId: r.specialtyId,
    directorName: r.directorName,
    proceduresBooked: r.proceduresBooked,
    // Sorted so a reordered fetch does not read as a change in the audit diff.
    attendings: [...r.attendings]
      .sort((a, b) => (a.slotId === b.slotId ? a.order - b.order : a.slotId < b.slotId ? -1 : 1))
      .map((a) => ({ slotId: a.slotId, attendingId: a.attendingId })),
  };
}

async function assertAttendingExists(id: string, label: string): Promise<void> {
  const found = await prisma.attending.findUnique({ where: { id }, select: { id: true } });
  if (!found) throw new BuilderValidationError(`That ${label} no longer exists.`);
}

/**
 * Validate posted slot assignments.
 *
 * Returns null when the caller submitted nothing, which must mean "leave the
 * assignments alone" rather than "clear them": a director-name-only save lands
 * here.
 *
 * Both ids are posted by the form, so both are checked: the slot must be a real
 * column, and every attending must be on the roster. A slot that does not allow
 * multiple attendings is held to one, so the constraint the schedule shows is
 * the constraint the service enforces.
 */
async function resolveSlotAssignments(
  attendingsBySlot: Record<string, string[]> | undefined
): Promise<Array<{ slotId: string; attendingIds: string[] }> | null> {
  if (!attendingsBySlot) return null;
  const entries = Object.entries(attendingsBySlot);
  if (entries.length === 0) return null;

  const [slots, roster] = await Promise.all([
    prisma.clinicSlot.findMany({ select: { id: true, label: true, allowsMultiple: true } }),
    prisma.attending.findMany({ select: { id: true } }),
  ]);
  const slotById = new Map(slots.map((s) => [s.id, s]));
  const onRoster = new Set(roster.map((a) => a.id));

  return entries.map(([slotId, rawIds]) => {
    const slot = slotById.get(slotId);
    if (!slot) throw new BuilderValidationError("That time slot no longer exists.");

    // Dedupe: the unique index would reject a repeat anyway, and a cell that
    // names the same person twice is a slip rather than something to fail on.
    const attendingIds = [...new Set(rawIds.filter(Boolean))];
    for (const id of attendingIds) {
      if (!onRoster.has(id)) throw new BuilderValidationError("That attending is not on the roster.");
    }
    if (!slot.allowsMultiple && attendingIds.length > 1) {
      throw new BuilderValidationError(`${slot.label} takes one attending.`);
    }
    return { slotId, attendingIds };
  });
}

// ---------------------------------------------------------------------------
// builderView types
// ---------------------------------------------------------------------------

/** Scheduling preferences a member gave during training intake (training quiz).
 *  Surfaced to directors in the builder; never auto-applied to capacity math. */
export type BuilderMemberIntake = {
  /** Minimum shifts the member wants this term (free text, e.g. "4"). */
  minShiftsWanted: string | null;
  /** Free-text availability beyond their checked dates. */
  additionalShiftAvailability: string | null;
  /** Free-text note the member addressed to the directors. */
  feedback: string | null;
};

export type BuilderMember = {
  membershipId: string;
  person: { id: string; name: string; verifiedLanguages: string[]; licensedRN: boolean };
  kind: "DIRECTOR" | "VOLUNTEER";
  availability: ResolvedAvailability;
  overrideActive: boolean;
  acknowledgePending: boolean;
  legacyNote: string | null;
  intake: BuilderMemberIntake;
};

/** Just the fields {@link compareBuilderMembers} needs; any BuilderMember satisfies it. */
type BuilderMemberOrder = Pick<BuilderMember, "kind"> & { person: { name: string } };

/**
 * Ordering for the builder's member lists: directors first, then volunteers,
 * each group sorted alphabetically by name. Used by the Day view's
 * "Available to assign" pool and the grid view so both surfaces match.
 */
export function compareBuilderMembers(a: BuilderMemberOrder, b: BuilderMemberOrder): number {
  if (a.kind !== b.kind) return a.kind === "DIRECTOR" ? -1 : 1;
  return a.person.name.localeCompare(b.person.name);
}

export type BuilderAssignmentEntry = {
  role: "VOLUNTEER" | "SHADOW" | "DIRECTOR";
  tags: ShiftTags;
  /**
   * Identity of the assignee, carried from the loaded ShiftAssignment.person so a
   * non-member assignee (someone offboarded out of their ACTIVE membership while a
   * future ShiftAssignment outlives it) still renders by name + flags in the Day
   * view instead of a raw personId cuid. Members are always in `members`; this is
   * the fallback source for everyone else.
   */
  person: { name: string; verifiedLanguages: string[]; licensedRN: boolean };
};

export type BuilderRhd = {
  readiness: ClinicReadiness;
  /**
   * The per-DAY row. Who is covering lives on `readiness.attendings`, one entry
   * per staffed slot; the panel shows names rather than an options list, because
   * /schedule/attendings owns that write.
   *
   * `directorName` on this row is legacy: it is still written by the Airtable
   * import and read as a fallback below, but nothing in the app types it any
   * more. Who is directing is a fact about the schedule (see `directors`).
   */
  clinic: ClinicDay | null;
  /**
   * The directors actually on the reproductive health schedule for this date,
   * derived from their DIRECTOR-role shift assignments across the RHD
   * departments. This replaced the hand-typed "director on point" field: the
   * schedule already knows, and a second place to say it was only ever a way for
   * the two to disagree.
   *
   * Carries person ids so the panel can link a name through to their profile,
   * which is the question a director actually has when they read this row.
   */
  directors: { id: string; name: string }[];
};

export type BuilderView = {
  departments: { id: string; code: string; name: string }[];
  selectedDepartment: { id: string; code: string; name: string } | null;
  clinicDates: Date[];
  selectedDate: Date | null;
  selectedDateKey: string | null;
  /** The current week's clinic Saturday (first clinic date >= today), or null
   *  when the term has no clinic dates. Used for the grid-view "this week"
   *  highlight, independent of the selected date. */
  currentClinicDateKey: string | null;
  members: BuilderMember[];
  /** Nested map: dateKey -> personId -> assignment entry. */
  assignmentsByDate: Record<string, Record<string, BuilderAssignmentEntry>>;
  capacity: DayMetrics;
  /** True when the selected department has capacity config (idealHeadcount or
   *  patientCapacityPerProvider). The capacity panel renders only for these
   *  departments, mirroring the legacy `capacity && <CapacityPanel/>` gate. */
  hasCapacityConfig: boolean;
  banner: DeptBanner[];
  /** Map: personId -> array of other-department names with same-day conflict. */
  conflicts: Record<string, string[]>;
  /**
   * Members fully cleared for the date being built, for the verified badge.
   * Plain string[] rather than a Set so it survives the RSC boundary intact.
   * Computed from the same loadClearanceMap pass that feeds `banner`, so a badge
   * and the banner can never disagree about the same person.
   */
  clearedPersonIds: string[];
  pendingRequestCount: number;
  rhd: BuilderRhd | null;
  /**
   * Contact addresses for everyone assigned to the selected date in the selected
   * department, deduped and sorted, for the copyable shift email list.
   *
   * Every role, shadows included: the list exists so a director can mail the
   * people who will be in the building, and a shadow is one of them. Someone
   * with no contactEmail on file is simply absent -- the list is a convenience,
   * not a roster, and a blank entry would silently break a paste into a To:
   * field.
   */
  shiftEmails: string[];
};

/**
 * The primary read for the schedule builder page.
 *
 * Returns the viewer's selectable departments, the selected department and date,
 * all members with resolved availability, all term assignments (for the grid),
 * capacity metrics, compliance banner, conflicts, pending request count, and
 * (for RHD departments) the RHD clinic block.
 */
export async function builderView(
  viewerPersonId: string,
  opts: { departmentId?: string; dateKey?: string; now?: Date; termId: string }
): Promise<BuilderView> {
  const now = opts.now ?? new Date();

  const manageableIds = await manageableScheduleDepartmentIds(viewerPersonId);

  // Empty state when viewer manages nothing.
  const emptyMetrics = computeDayMetrics(
    { onShift: 0, triage: 0, walkin: 0, cc: 0, shadow: 0, spanish: 0, patientsBooked: null },
    { idealHeadcount: null, patientCapacityPerProvider: null }
  );

  if (manageableIds.length === 0) {
    return {
      departments: [],
      selectedDepartment: null,
      clinicDates: [],
      selectedDate: null,
      selectedDateKey: null,
      currentClinicDateKey: null,
      members: [],
      assignmentsByDate: {},
      capacity: emptyMetrics,
      hasCapacityConfig: false,
      banner: [],
    clearedPersonIds: [],
      conflicts: {},
      pendingRequestCount: 0,
      rhd: null,
      shiftEmails: [],
    };
  }

  // Load departments in code order.
  const departments = await prisma.department.findMany({
    where: { id: { in: manageableIds } },
    orderBy: { code: "asc" },
  });

  // Resolve selected department.
  const selectedDept =
    opts.departmentId
      ? departments.find((d) => d.id === opts.departmentId) ?? departments[0]
      : departments[0];

  const deptLites = departments.map((d) => ({ id: d.id, code: d.code, name: d.name }));

  // Load the working term by id (no archived guard -- viewing an archived term
  // read-only is allowed).
  const term = await prisma.term.findUnique({ where: { id: opts.termId } });
  if (!term) {
    return {
      departments: deptLites,
      selectedDepartment: { id: selectedDept.id, code: selectedDept.code, name: selectedDept.name },
      clinicDates: [],
      selectedDate: null,
      selectedDateKey: null,
      currentClinicDateKey: null,
      members: [],
      assignmentsByDate: {},
      capacity: emptyMetrics,
      hasCapacityConfig: false,
      banner: [],
    clearedPersonIds: [],
      conflicts: {},
      pendingRequestCount: 0,
      rhd: null,
      shiftEmails: [],
    };
  }

  const { clinicDates } = term;

  // The current week's clinic Saturday: the first clinic date on or after today
  // (clinic dates are weekly Saturdays). Used as a fixed wayfinding highlight in
  // the grid view, independent of which date is selected for editing.
  // displayTodayKey resolves "today" as the display-zone (ET) calendar day; a
  // raw isoDateKey(new Date()) would roll over at ~8pm ET and, for the last few
  // hours of a clinic day, highlight next week instead of today.
  const nowKey = await displayTodayKey(now);
  const currentClinicDate =
    clinicDates.find((d) => isoDateKey(d) >= nowKey) ?? null;
  const currentClinicDateKey = currentClinicDate ? isoDateKey(currentClinicDate) : null;

  // Resolve selected date (Day view): explicit ?date= param, else default to the
  // current clinic Saturday, else the last clinic date of the term.
  let selectedDate: Date | null = null;
  if (opts.dateKey) {
    selectedDate = clinicDates.find((d) => isoDateKey(d) === opts.dateKey) ?? null;
  }
  if (!selectedDate) {
    selectedDate = currentClinicDate ?? (clinicDates[clinicDates.length - 1] ?? null);
  }
  const selectedDateKey = selectedDate ? isoDateKey(selectedDate) : null;

  // Load all assignments for the term in the selected department.
  const [allAssignments, members, scheduleDay, pendingCount] = await Promise.all([
    prisma.shiftAssignment.findMany({
      where: { termId: term.id, departmentId: selectedDept.id },
      include: {
        person: { select: { id: true, name: true, licensedRN: true, contactEmail: true } },
      },
    }),
    prisma.termMembership.findMany({
      where: { termId: term.id, departmentId: selectedDept.id, status: "ACTIVE" },
      include: { person: true },
      orderBy: { person: { name: "asc" } },
    }),
    selectedDate
      ? prisma.scheduleDay.findFirst({
          where: { termId: term.id, departmentId: selectedDept.id, clinicDate: selectedDate },
        })
      : Promise.resolve(null),
    prisma.shiftRequest.count({
      where: { termId: term.id, departmentId: selectedDept.id, status: "PENDING" },
    }),
  ]);

  // Verified language capabilities for everyone on this board, in one query.
  // Only VERIFIED languages reach the builder: a self-reported claim is an
  // intake signal and must not read as a capability a director can schedule on.
  const languageMap = await verifiedLanguagesByPerson([
    ...new Set([...allAssignments.map((a) => a.personId), ...members.map((m) => m.person.id)]),
  ]);

  // Build assignmentsByDate.
  const assignmentsByDate: Record<string, Record<string, BuilderAssignmentEntry>> = {};
  for (const a of allAssignments) {
    const dk = isoDateKey(a.clinicDate);
    if (!assignmentsByDate[dk]) assignmentsByDate[dk] = {};
    assignmentsByDate[dk][a.personId] = {
      role: a.role as "VOLUNTEER" | "SHADOW" | "DIRECTOR",
      tags: { triage: a.triage, walkin: a.walkin, cc: a.cc, remote: a.remote, specialty: a.specialty },
      person: {
        name: a.person.name,
        verifiedLanguages: languageMap.get(a.personId) ?? [],
        licensedRN: a.person.licensedRN,
      },
    };
  }

  // Load each member's training intake (scheduling preferences from the training
  // quiz), keyed by personId:track. A member's track is their membership kind, so
  // a VOLUNTEER-kind member only ever shows VOLUNTEER-track intake.
  const memberPersonIds = members.map((m) => m.person.id);
  const trainingRows = memberPersonIds.length
    ? await prisma.training.findMany({
        where: { termId: term.id, personId: { in: memberPersonIds } },
        select: {
          personId: true,
          track: true,
          minShiftsWanted: true,
          additionalShiftAvailability: true,
          feedback: true,
        },
      })
    : [];
  const intakeByKey = new Map(trainingRows.map((t) => [`${t.personId}:${t.track}`, t]));

  // Build members list.
  const builderMembers: BuilderMember[] = members.map((m) => {
    const availability = resolveAvailability({
      baseline: m.baselineAvailability,
      selfDates: m.selfAvailabilityDates,
      selfUpdatedAt: m.availabilityUpdatedAt,
      directorDates: m.directorAvailabilityDates,
      directorSetAt: m.directorAvailabilitySetAt,
    });

    const intakeRow = intakeByKey.get(`${m.person.id}:${m.kind}`);

    return {
      membershipId: m.id,
      person: {
        id: m.person.id,
        name: m.person.name,
        verifiedLanguages: languageMap.get(m.person.id) ?? [],
        licensedRN: m.person.licensedRN,
      },
      kind: m.kind as "DIRECTOR" | "VOLUNTEER",
      availability,
      overrideActive: m.directorAvailabilitySetAt !== null,
      acknowledgePending:
        m.availabilityUpdatedAt !== null && m.availabilityAcknowledgedAt === null,
      legacyNote: m.selfUpdatedAvailability ?? null,
      intake: {
        minShiftsWanted: intakeRow?.minShiftsWanted ?? null,
        additionalShiftAvailability: intakeRow?.additionalShiftAvailability ?? null,
        feedback: intakeRow?.feedback ?? null,
      },
    };
  });

  // Capacity for the selected date.
  const selectedAssignments = selectedDateKey ? allAssignments.filter((a) => isoDateKey(a.clinicDate) === selectedDateKey) : [];

  // The copyable shift email list. Built from the ASSIGNMENTS rather than the
  // department's members, so it is exactly the people working this date, and it
  // still carries someone who has since lost their membership but is still on
  // the schedule -- they are turning up, so they should get the email.
  const shiftEmails = [
    ...new Set(
      selectedAssignments
        .map((a) => a.person.contactEmail?.trim())
        .filter((e): e is string => Boolean(e)),
    ),
  ].sort();

  // Offboarding / removeMembership leave the ShiftAssignment row behind, so a
  // departed person would still inflate the day's capacity metrics (onShift,
  // spanish, triage/walkin/cc, shadow), pushing maxPatientCapacity up and hiding
  // the "Patients to reschedule" warning. Count only current members of this
  // department (the ACTIVE `members` set) toward capacity; the stranded
  // assignment still renders in the grid so a director can reassign it.
  const activeMemberIds = new Set(members.map((m) => m.person.id));
  const capacityAssignments = selectedAssignments.filter((a) => activeMemberIds.has(a.personId));

  const onShiftPeople = capacityAssignments.filter((a) => a.role === "VOLUNTEER" || a.role === "DIRECTOR");
  // Spanish specifically: the capacity model asks how many Spanish speakers are
  // on shift, because that is what bounds how many Spanish-speaking patients the
  // clinic can see. Reads from the language map now rather than a Person column,
  // so it counts a VERIFIED capability and nothing else.
  const spanishCount = onShiftPeople.filter((a) =>
    (languageMap.get(a.personId) ?? []).includes("es"),
  ).length;

  const capacity = computeDayMetrics(
    {
      onShift: onShiftPeople.length,
      triage: capacityAssignments.filter((a) => a.triage).length,
      walkin: capacityAssignments.filter((a) => a.walkin).length,
      cc: capacityAssignments.filter((a) => a.cc).length,
      shadow: capacityAssignments.filter((a) => a.role === "SHADOW").length,
      spanish: spanishCount,
      patientsBooked: scheduleDay?.patientsBooked ?? null,
    },
    {
      idealHeadcount: selectedDept.idealHeadcount ?? null,
      patientCapacityPerProvider: selectedDept.patientCapacityPerProvider ?? null,
    }
  );

  // Banner: full clearance for VOLUNTEER assignees on the selected date. Anyone not
  // fully cleared (profile, HIPAA, training, learning, or EHS) cannot work that date.
  const volunteerAssigneesOnDate = selectedAssignments.filter((a) => a.role === "VOLUNTEER");

  // Build a memberById Map for O(1) lookups instead of O(n) linear scan per assignee.
  const memberById = new Map(members.map((m) => [m.person.id, m]));

  // ONE clearance pass covering both consumers: the not-cleared banner (volunteer
  // assignees on this date) and the verified badge on every assignable member
  // card. Widening the existing call is free relative to making a second one --
  // loadClearanceMap's cost is per-call, not per-person -- and it guarantees the
  // banner and the badges can never disagree about the same person.
  //
  // Note this deliberately passes `now`, the builder's reference time, so a
  // badge answers "cleared for the date being built" rather than "cleared today".
  const clearanceScope = [
    ...new Set([...volunteerAssigneesOnDate.map((a) => a.personId), ...members.map((m) => m.person.id)]),
  ];
  const bannerClearance = await loadClearanceMap(clearanceScope, term.id, now);

  const bannerVolunteers = volunteerAssigneesOnDate.map((a) => {
    const person = memberById.get(a.personId)?.person ?? a.person;
    const cleared = bannerClearance.get(a.personId)?.cleared ?? true;
    return { id: person.id, name: person.name, cleared };
  });

  const banner = summarizeNotCleared([
    {
      departmentId: selectedDept.id,
      departmentName: selectedDept.name,
      volunteers: bannerVolunteers,
    },
  ]);

  // Conflicts: load ALL term assignments across ALL departments for conflict computation.
  const allTermAssignments = await prisma.shiftAssignment.findMany({
    where: { termId: term.id },
    select: {
      personId: true,
      departmentId: true,
      clinicDate: true,
      role: true,
      department: { select: { name: true } },
    },
  });

  const engineRows = allTermAssignments.map((a) => ({
    departmentId: a.departmentId,
    departmentName: a.department.name,
    personId: a.personId,
    clinicDate: a.clinicDate,
    role: a.role as "DIRECTOR" | "VOLUNTEER" | "SHADOW",
  }));
  const allEntries = toScheduleEntries(engineRows);

  const conflicts: Record<string, string[]> = {};
  if (selectedDateKey) {
    for (const a of selectedAssignments) {
      const result = computeConflicts({
        personId: a.personId,
        thisDepartmentId: selectedDept.id,
        allSchedule: allEntries,
      });
      const otherDeptNames = result.sameDay
        .filter((c) => c.date === selectedDateKey)
        .map((c) => c.otherDept);
      if (otherDeptNames.length > 0) {
        conflicts[a.personId] = otherDeptNames;
      }
    }
  }

  // RHD block. Still reproductive-health-only: the readiness panel is about
  // procedure coverage (IUD, Nexplanon), which no other part of the clinic has.
  // It reads the RHD Attending column of the clinic-wide schedule rather than a
  // schedule of its own.
  const rhd = RHD_CODES.has(selectedDept.code)
    ? await buildRhdBlock(term, departments, selectedDateKey, allTermAssignments)
    : null;

  return {
    departments: deptLites,
    selectedDepartment: { id: selectedDept.id, code: selectedDept.code, name: selectedDept.name },
    clinicDates,
    selectedDate,
    selectedDateKey,
    currentClinicDateKey,
    members: builderMembers,
    assignmentsByDate,
    capacity,
    hasCapacityConfig:
      selectedDept.idealHeadcount != null || selectedDept.patientCapacityPerProvider != null,
    banner,
    conflicts,
    // Plain string[], not a Set: this crosses into components and a Set would
    // not survive serialization intact. Callers rebuild a Set if they want O(1).
    clearedPersonIds: [...bannerClearance]
      .filter(([, summary]) => summary.cleared)
      .map(([personId]) => personId),
    pendingRequestCount: pendingCount,
    rhd,
    shiftEmails,
  };
}

// ---------------------------------------------------------------------------
// RHD block builder (private)
// ---------------------------------------------------------------------------

type MinimalAssignment = {
  personId: string;
  departmentId: string;
  clinicDate: Date;
  role: string;
  department: { name: string };
};

/**
 * Builds the RHD block for the builderView.
 * Loads ClinicDay (with attending included), attending options, and computes readiness.
 *
 * departments: the already-fetched list from builderView. If all three RHD codes
 * (SCTS, JCTS, CCRH) are present in it, no extra department query is needed.
 * When some are missing (actor only manages a subset), a single fallback query
 * fetches the remaining ones.
 */
async function buildRhdBlock(
  term: { id: string; clinicDates: Date[] },
  departments: { id: string; code: string; name: string }[],
  selectedDateKey: string | null,
  allTermAssignments: MinimalAssignment[]
): Promise<BuilderRhd | null> {
  if (!selectedDateKey) return null;

  const clinicDate = term.clinicDates.find((d) => isoDateKey(d) === selectedDateKey);
  if (!clinicDate) return null;

  // Derive RHD dept id/code pairs from the already-fetched departments list.
  // If any of the three are missing, do one fallback query to fill the gaps.
  const rhdFromDepts = departments.filter((d) => RHD_CODES.has(d.code));
  const missingCodes = [...RHD_CODES].filter((c) => !rhdFromDepts.some((d) => d.code === c));

  const rhdDepts: { id: string; code: string }[] =
    missingCodes.length === 0
      ? rhdFromDepts
      : [
          ...rhdFromDepts,
          ...(await prisma.department.findMany({
            where: { code: { in: missingCodes } },
            select: { id: true, code: true },
          })),
        ];

  const deptIdToCode = new Map(rhdDepts.map((d) => [d.id, d.code]));

  // The day's row, with only the REPRODUCTIVE HEALTH coverage. The schedule is
  // clinic-wide, so the panel filters to the slots that staff this clinic rather
  // than counting the primary care or behavioral health columns as its own.
  const clinic = await prisma.clinicDay.findFirst({
    where: { termId: term.id, clinicDate },
    include: {
      attendings: {
        where: { slot: { label: { in: [...RHD_SLOT_LABELS] } } },
        // Slot order, so the panel lists the day the way it is worked.
        orderBy: [{ slot: { order: "asc" } }, { order: "asc" }],
        include: {
          slot: { select: { label: true } },
          attending: {
            include: {
              capabilities: { select: { value: true, capability: { select: { key: true } } } },
            },
          },
        },
      },
    },
  });

  // Project each attending's stored answers onto the engine's fixed six-key
  // record. The engine is a port and wants all six present; the store keeps only
  // non-"unknown" answers, so an absent key is unknown -- which is also the right
  // answer if this line has stopped asking that question.
  //
  // One entry per STAFFED slot. The engine unions them into per-day coverage,
  // because procedures booked is a per-day number.
  //
  // DEACTIVATED attendings are excluded, so a slot they still occupy reads as a
  // gap here exactly as it does on the attending schedule. Previously the name
  // was resolved from the active roster (showing "Not set") while their
  // qualifications still fed the procedure row, so the panel could claim IUD
  // coverage from someone it simultaneously showed as not covering.
  const attendings: ReadinessAttending[] = (clinic?.attendings ?? []).filter((row) => row.attending.isActive).map((row) => {
    const att = row.attending;
    const byKey = new Map(att.capabilities.map((c) => [c.capability.key, c.value]));
    const procedures = Object.fromEntries(
      PROCEDURE_KEYS.map((k) => [k, (byKey.get(k) ?? "unknown") as ProcedureStatus]),
    ) as Record<ProcedureKey, ProcedureStatus>;

    return {
      id: att.id,
      scheduleName: att.scheduleName,
      fullName: att.fullName,
      slotLabel: row.slot.label,
      procedures,
      notes: att.notes ?? undefined,
    };
  });

  // Build RhdPersonLite lists for each RHD department on the selected date.
  const selectedRhdAssignments = allTermAssignments.filter(
    (a) =>
      isoDateKey(a.clinicDate) === selectedDateKey &&
      deptIdToCode.has(a.departmentId) &&
      (a.role === "VOLUNTEER" || a.role === "DIRECTOR")
  );

  const personIds = [...new Set(selectedRhdAssignments.map((a) => a.personId))];
  const [persons, rhdLanguages] = await Promise.all([
    personIds.length > 0
      ? prisma.person.findMany({
          where: { id: { in: personIds } },
          select: { id: true, name: true, contactEmail: true, licensedRN: true },
        })
      : Promise.resolve([]),
    verifiedLanguagesByPerson(personIds),
  ]);
  const personMap = new Map(persons.map((p) => [p.id, p]));

  // Who is directing, read off the schedule instead of typed by hand. Deduped
  // because one person can direct two of the three RHD departments on the same
  // date, and sorted so the row does not reshuffle between renders.
  const directors = [
    ...new Map(
      selectedRhdAssignments
        .filter((a) => a.role === "DIRECTOR")
        .map((a) => [a.personId, { id: a.personId, name: personMap.get(a.personId)?.name ?? "Unknown" }]),
    ).values(),
  ].sort((a, b) => a.name.localeCompare(b.name));

  function toRhdPerson(personId: string): RhdPersonLite {
    const p = personMap.get(personId);
    return {
      id: personId,
      email: p?.contactEmail ?? "",
      licensedRN: p?.licensedRN ?? false,
      spanishVerified: (rhdLanguages.get(personId) ?? []).includes("es"),
    };
  }

  const sctsId = rhdDepts.find((d) => d.code === "SCTS")?.id;
  const jctsId = rhdDepts.find((d) => d.code === "JCTS")?.id;
  const ccrhId = rhdDepts.find((d) => d.code === "CCRH")?.id;

  const sctsOnShift = selectedRhdAssignments
    .filter((a) => a.departmentId === sctsId)
    .map((a) => toRhdPerson(a.personId));
  const jctsOnShift = selectedRhdAssignments
    .filter((a) => a.departmentId === jctsId)
    .map((a) => toRhdPerson(a.personId));
  const ccrhOnShift = selectedRhdAssignments
    .filter((a) => a.departmentId === ccrhId)
    .map((a) => toRhdPerson(a.personId));

  const readiness = computeClinicReadiness({
    date: selectedDateKey,
    attendings,
    // Derived from the schedule, falling back to the stored name only when
    // nobody is assigned. The stored value is no longer typed anywhere in the
    // app, but the Airtable import still writes it for historical dates, and a
    // past clinic day should not lose the director it recorded.
    director: directors.map((d) => d.name).join(", ") || clinic?.directorName || null,
    sctsOnShift,
    jctsOnShift,
    ccrhOnShift,
    proceduresBooked: clinic?.proceduresBooked ?? null,
    maxProceduresPerClinic: await getSetting<number>("rhd.maxProcedures"),
  });

  // Strip the included relation before returning to match the ClinicDay type.
  const clinicRow: ClinicDay | null = clinic
    ? (({ attendings: _attendings, ...rest }) => rest)(clinic) as ClinicDay
    : null;

  return { readiness, clinic: clinicRow, directors };
}
