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

import type { RhdClinic } from "@prisma/client";
import { prisma } from "@/platform/db";
import { recordAudit } from "@/platform/audit";
import { isoDateKey } from "@/platform/dates";
import { manageableDepartmentIds, memberDepartmentIds } from "@/platform/departments";
import { can } from "@/platform/rbac/engine";
import { complianceStatus } from "@/platform/compliance/rules";
import { resolveAvailability } from "../engine/availability";
import type { ResolvedAvailability } from "../engine/availability";
import { toScheduleEntries } from "../engine/map";
import { computeConflicts } from "../engine/conflicts";
import { computeDayMetrics } from "../engine/capacity";
import type { DayMetrics } from "../engine/capacity";
import { summarizeNonCompliant } from "../engine/banner";
import type { DeptBanner } from "../engine/banner";
import { computeClinicReadiness } from "../engine/rhd";
import type { ClinicReadiness, RhdPersonLite, Attending } from "../engine/rhd";
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
// RHD department codes
// ---------------------------------------------------------------------------

export const RHD_CODES = new Set(["SCTS", "JCTS", "CCRH"]);

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Returns the active term or null. */
async function getActiveTerm() {
  return prisma.term.findFirst({
    where: { status: "ACTIVE" },
    orderBy: { startDate: "desc" },
  });
}

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
 * purposes: manageableDepartmentIds(personId) UNION (when
 * can(personId, "schedule.edit_own_dept")) memberDepartmentIds(personId)
 * UNION (when can(personId, "schedule.edit_all")) ALL department ids. Deduped.
 */
export async function manageableScheduleDepartmentIds(personId: string): Promise<string[]> {
  const [base, editOwnDept, editAll] = await Promise.all([
    manageableDepartmentIds(personId),
    can(personId, "schedule.edit_own_dept"),
    can(personId, "schedule.edit_all"),
  ]);

  const ids = new Set<string>(base);

  // edit_own_dept: extend to departments the person is an active member of.
  if (editOwnDept) {
    for (const id of await memberDepartmentIds(personId)) ids.add(id);
  }

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

// ---------------------------------------------------------------------------
// setAssignment
// ---------------------------------------------------------------------------

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
    departmentId: string;
    dateKey: string;
    personId: string;
    role: "VOLUNTEER" | "SHADOW" | "DIRECTOR" | null;
    reason?: string;
  }
): Promise<void> {
  await scopeCheck(actor, opts.departmentId);

  const term = await getActiveTerm();
  if (!term) throw new BuilderValidationError("No active term.");

  // Validate clinic date.
  const clinicDate = term.clinicDates.find((d) => isoDateKey(d) === opts.dateKey);
  if (!clinicDate) {
    throw new BuilderValidationError(`${opts.dateKey} is not a clinic date in the active term.`);
  }

  if (opts.role !== null) {
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
    // Unassign: capture before state then delete.
    const existing = await prisma.shiftAssignment.findFirst({
      where: {
        termId: term.id,
        departmentId: opts.departmentId,
        clinicDate,
        personId: opts.personId,
      },
    });

    await prisma.shiftAssignment.deleteMany({
      where: {
        termId: term.id,
        departmentId: opts.departmentId,
        clinicDate,
        personId: opts.personId,
      },
    });

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

// ---------------------------------------------------------------------------
// toggleTag
// ---------------------------------------------------------------------------

/**
 * Flips a boolean tag (triage, walkin, cc, remote) on an existing assignment.
 *
 * Throws BuilderValidationError when no assignment row exists for the
 * person/date/department combination.
 */
export async function toggleTag(
  actor: string,
  opts: {
    departmentId: string;
    dateKey: string;
    personId: string;
    tag: "triage" | "walkin" | "cc" | "remote";
  }
): Promise<void> {
  await scopeCheck(actor, opts.departmentId);

  const term = await getActiveTerm();
  if (!term) throw new BuilderValidationError("No active term.");

  const clinicDate = term.clinicDates.find((d) => isoDateKey(d) === opts.dateKey);
  if (!clinicDate) {
    throw new BuilderValidationError(`${opts.dateKey} is not a clinic date in the active term.`);
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

// ---------------------------------------------------------------------------
// setPatientsBooked
// ---------------------------------------------------------------------------

/**
 * Upserts the patientsBooked field on the ScheduleDay row for a
 * (term, department, date) triple. A null value clears the field.
 */
export async function setPatientsBooked(
  actor: string,
  opts: { departmentId: string; dateKey: string; patientsBooked: number | null }
): Promise<void> {
  await scopeCheck(actor, opts.departmentId);

  const term = await getActiveTerm();
  if (!term) throw new BuilderValidationError("No active term.");

  const clinicDate = term.clinicDates.find((d) => isoDateKey(d) === opts.dateKey);
  if (!clinicDate) {
    throw new BuilderValidationError(`${opts.dateKey} is not a clinic date in the active term.`);
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

// ---------------------------------------------------------------------------
// setAvailabilityOverride
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// acknowledgeAvailability
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// upsertRhdClinic
// ---------------------------------------------------------------------------

/**
 * Upserts the RhdClinic row for a term+date.
 *
 * Actor must manage at least one RHD-family department (SCTS, JCTS, CCRH).
 * The dateKey must be a clinic date in the active term.
 */
export async function upsertRhdClinic(
  actor: string,
  opts: {
    dateKey: string;
    attendingId?: string | null;
    directorName?: string | null;
    proceduresBooked?: number | null;
  }
): Promise<void> {
  // Scope: must manage at least one RHD department.
  const manageable = await manageableScheduleDepartmentIds(actor);
  const rhdDepts = await prisma.department.findMany({
    where: { code: { in: [...RHD_CODES] } },
    select: { id: true },
  });
  const rhdIds = new Set(rhdDepts.map((d) => d.id));
  const hasRhd = manageable.some((id) => rhdIds.has(id));
  if (!hasRhd) throw new BuilderForbiddenError("Actor does not manage any RHD-family department.");

  const term = await getActiveTerm();
  if (!term) throw new BuilderValidationError("No active term.");

  const clinicDate = term.clinicDates.find((d) => isoDateKey(d) === opts.dateKey);
  if (!clinicDate) {
    throw new BuilderValidationError(`${opts.dateKey} is not a clinic date in the active term.`);
  }

  const rhdClinicBefore = await prisma.rhdClinic.findFirst({
    where: { termId: term.id, clinicDate },
    select: { attendingId: true, directorName: true, proceduresBooked: true },
  });

  const rhdClinicAfter = await prisma.rhdClinic.upsert({
    where: { termId_clinicDate: { termId: term.id, clinicDate } },
    create: {
      termId: term.id,
      clinicDate,
      attendingId: opts.attendingId ?? null,
      directorName: opts.directorName ?? null,
      proceduresBooked: opts.proceduresBooked ?? null,
    },
    update: {
      ...("attendingId" in opts && { attendingId: opts.attendingId ?? null }),
      ...("directorName" in opts && { directorName: opts.directorName ?? null }),
      ...("proceduresBooked" in opts && { proceduresBooked: opts.proceduresBooked ?? null }),
    },
    select: { attendingId: true, directorName: true, proceduresBooked: true },
  });

  await recordAudit({
    actorPersonId: actor,
    action: "schedule.rhd_clinic",
    entityType: "RhdClinic",
    entityId: `${term.id}|${opts.dateKey}`,
    ...(rhdClinicBefore && {
      before: { attendingId: rhdClinicBefore.attendingId, directorName: rhdClinicBefore.directorName, proceduresBooked: rhdClinicBefore.proceduresBooked },
    }),
    after: { attendingId: rhdClinicAfter.attendingId, directorName: rhdClinicAfter.directorName, proceduresBooked: rhdClinicAfter.proceduresBooked },
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
  person: { id: string; name: string; spanishVerified: boolean; licensedRN: boolean };
  kind: "DIRECTOR" | "VOLUNTEER";
  availability: ResolvedAvailability;
  overrideActive: boolean;
  acknowledgePending: boolean;
  legacyNote: string | null;
  intake: BuilderMemberIntake;
};

export type BuilderAssignmentEntry = {
  role: "VOLUNTEER" | "SHADOW" | "DIRECTOR";
  tags: { triage: boolean; walkin: boolean; cc: boolean; remote: boolean };
};

export type BuilderRhd = {
  readiness: ClinicReadiness;
  attendingOptions: { id: string; scheduleName: string }[];
  clinic: RhdClinic | null;
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
  pendingRequestCount: number;
  rhd: BuilderRhd | null;
};

// ---------------------------------------------------------------------------
// builderView
// ---------------------------------------------------------------------------

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
  opts: { departmentId?: string; dateKey?: string; now?: Date }
): Promise<BuilderView> {
  const now = opts.now ?? new Date();

  const manageableIds = await manageableScheduleDepartmentIds(viewerPersonId);

  // Empty state when viewer manages nothing.
  const emptyMetrics = computeDayMetrics(
    { onShift: 0, triage: 0, walkin: 0, shadow: 0, spanish: 0, patientsBooked: null },
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
      conflicts: {},
      pendingRequestCount: 0,
      rhd: null,
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

  // Load active term.
  const term = await getActiveTerm();
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
      conflicts: {},
      pendingRequestCount: 0,
      rhd: null,
    };
  }

  const { clinicDates } = term;

  // The current week's clinic Saturday: the first clinic date on or after today
  // (clinic dates are weekly Saturdays). Used as a fixed wayfinding highlight in
  // the grid view, independent of which date is selected for editing.
  const nowKey = isoDateKey(now);
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
        person: { select: { id: true, name: true, spanishVerified: true, licensedRN: true } },
      },
    }),
    prisma.termMembership.findMany({
      where: { termId: term.id, departmentId: selectedDept.id, status: "ACTIVE" },
      include: {
        person: {
          include: { hipaaCertificates: { orderBy: { uploadedAt: "desc" }, take: 1 } },
        },
      },
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

  // Build assignmentsByDate.
  const assignmentsByDate: Record<string, Record<string, BuilderAssignmentEntry>> = {};
  for (const a of allAssignments) {
    const dk = isoDateKey(a.clinicDate);
    if (!assignmentsByDate[dk]) assignmentsByDate[dk] = {};
    assignmentsByDate[dk][a.personId] = {
      role: a.role as "VOLUNTEER" | "SHADOW" | "DIRECTOR",
      tags: { triage: a.triage, walkin: a.walkin, cc: a.cc, remote: a.remote },
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
        spanishVerified: m.person.spanishVerified,
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

  // Build a set of person details for spanish/RN counts.
  const personById = new Map(members.map((m) => [m.person.id, m.person]));

  const onShiftPeople = selectedAssignments.filter((a) => a.role === "VOLUNTEER" || a.role === "DIRECTOR");
  const spanishCount = onShiftPeople.filter((a) => {
    const p = personById.get(a.personId) ?? a.person;
    return p.spanishVerified;
  }).length;

  const capacity = computeDayMetrics(
    {
      onShift: onShiftPeople.length,
      triage: selectedAssignments.filter((a) => a.triage).length,
      walkin: selectedAssignments.filter((a) => a.walkin).length,
      shadow: selectedAssignments.filter((a) => a.role === "SHADOW").length,
      spanish: spanishCount,
      patientsBooked: scheduleDay?.patientsBooked ?? null,
    },
    {
      idealHeadcount: selectedDept.idealHeadcount ?? null,
      patientCapacityPerProvider: selectedDept.patientCapacityPerProvider ?? null,
    }
  );

  // Banner: compliance status for VOLUNTEER assignees on selected date.
  const volunteerAssigneesOnDate = selectedAssignments.filter((a) => a.role === "VOLUNTEER");

  // Build a memberById Map for O(1) lookups instead of O(n) linear scan per assignee.
  const memberById = new Map(members.map((m) => [m.person.id, m]));

  const bannerVolunteers = volunteerAssigneesOnDate.map((a) => {
    const memberEntry = memberById.get(a.personId);
    const certs = memberEntry?.person.hipaaCertificates ?? [];
    const newestCert = certs.length > 0 ? certs[0] : null;
    const status = complianceStatus(
      newestCert ? { completionDate: newestCert.completionDate } : null,
      term.endDate,
      now
    );
    const person = memberEntry?.person ?? a.person;
    return { id: person.id, name: person.name, status };
  });

  const banner = summarizeNonCompliant([
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

  // RHD block.
  let rhd: BuilderRhd | null = null;
  if (RHD_CODES.has(selectedDept.code)) {
    rhd = await buildRhdBlock(term, departments, selectedDateKey, allTermAssignments);
  }

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
    pendingRequestCount: pendingCount,
    rhd,
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
 * Loads RhdClinic (with attending included), attending options, and computes readiness.
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

  // Fetch attending options and clinic (with attending included) in parallel.
  const [attendingOptions, clinic] = await Promise.all([
    prisma.rhdAttending.findMany({
      where: { isActive: true },
      select: { id: true, scheduleName: true },
      orderBy: { scheduleName: "asc" },
    }),
    prisma.rhdClinic.findFirst({
      where: { termId: term.id, clinicDate },
      include: {
        attending: true,
      },
    }),
  ]);

  // Map the included attending to the engine Attending shape.
  let attending: Attending | null = null;
  if (clinic?.attending) {
    const att = clinic.attending;
    attending = {
      id: att.id,
      scheduleName: att.scheduleName,
      fullName: att.fullName,
      procedures: {
        iudIn: att.iudIn as "yes" | "no" | "unknown",
        iudOut: att.iudOut as "yes" | "no" | "unknown",
        nexplanon: att.nexplanon as "yes" | "no" | "unknown",
        gac: att.gac as "yes" | "no" | "unknown",
        emb: att.emb as "yes" | "no" | "unknown",
        seesMale: att.seesMale as "yes" | "no" | "unknown",
      },
      notes: att.notes ?? undefined,
    };
  }

  // Build RhdPersonLite lists for each RHD department on the selected date.
  const selectedRhdAssignments = allTermAssignments.filter(
    (a) =>
      isoDateKey(a.clinicDate) === selectedDateKey &&
      deptIdToCode.has(a.departmentId) &&
      (a.role === "VOLUNTEER" || a.role === "DIRECTOR")
  );

  const personIds = [...new Set(selectedRhdAssignments.map((a) => a.personId))];
  const persons = personIds.length > 0
    ? await prisma.person.findMany({
        where: { id: { in: personIds } },
        select: { id: true, contactEmail: true, licensedRN: true, spanishVerified: true },
      })
    : [];
  const personMap = new Map(persons.map((p) => [p.id, p]));

  function toRhdPerson(personId: string): RhdPersonLite {
    const p = personMap.get(personId);
    return {
      id: personId,
      email: p?.contactEmail ?? "",
      licensedRN: p?.licensedRN ?? false,
      spanishVerified: p?.spanishVerified ?? false,
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
    attending,
    director: clinic?.directorName ?? null,
    sctsOnShift,
    jctsOnShift,
    ccrhOnShift,
    proceduresBooked: clinic?.proceduresBooked ?? null,
    maxProceduresPerClinic: await getSetting<number>("rhd.maxProcedures"),
  });

  // Strip the included attending relation before returning to match RhdClinic type.
  const clinicRow: RhdClinic | null = clinic
    ? (({ attending: _attending, ...rest }) => rest)(clinic) as RhdClinic
    : null;

  return { readiness, attendingOptions, clinic: clinicRow };
}
