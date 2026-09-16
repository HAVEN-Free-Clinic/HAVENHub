import { Prisma, type DualAppointmentStatus } from "@prisma/client";
import { prisma, type TransactionClient } from "@/platform/db";
import { can } from "@/platform/rbac/engine";
import { peopleWithPermission } from "@/platform/rbac/permission-holders";
import { recordAudit } from "@/platform/audit";
import { log, errorAttrs } from "@/platform/logging";
import { getSetting } from "@/platform/settings/service";
import { notify } from "@/platform/notifications/notify";
import { renderEmail } from "@/platform/email/templates/renderEmail";
import { firstNameOf, comparePersonName } from "@/platform/person-name";
import { addMembership } from "@/platform/memberships/add";
import { getActiveTerm } from "@/platform/terms/active-term";
import { adoptIncomingShiftsTx, applicationAvailabilityDates } from "@/platform/recruitment/incoming-roster";
import { ACTIVE_DUAL_APPOINTMENT_STATUSES, MAX_APPOINTED_DEPARTMENTS, isAcceptanceConflict } from "../engine/dual-appointments";
import { canViewApplication, reviewScope, RecruitmentAuthError } from "./review";

/**
 * Dual appointments: accepting one volunteer into a SECOND department in the
 * same cycle.
 *
 * The clinic allows it rarely, for strong volunteers, so it is a request and an
 * approval rather than something a department can do alone. A director asks for
 * a volunteer they want (PENDING), and a recruitment manager -- anyone holding
 * recruitment.review_all -- approves or declines. A manager can also add one
 * directly, already approved.
 *
 * Approval mints the second department's Acceptance. From there the ordinary
 * machinery carries it: the conflict guard reads the APPROVED row and stops
 * calling the pair a conflict, Release sends one acceptance email naming both
 * departments, the one onboarding contract covers both, and promotion puts the
 * person on both rosters. Approving after promotion adds the second membership
 * straight away.
 *
 * Volunteer cycles only. A director-track application is interviewed and
 * decided per department already, and a second directorship is not what this is
 * for.
 */

export class DualAppointmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DualAppointmentError";
  }
}

/** Who approves, declines, cancels, and adds dual appointments. */
export const DUAL_APPOINTMENT_MANAGER_PERMISSION = "recruitment.review_all";

/** The note an approval writes on the Acceptance it mints, for anyone reading the row. */
export const DUAL_APPOINTMENT_ACCEPTANCE_NOTE = "Dual appointment";

export function dualAppointmentsPath(cycleId: string): string {
  return `/recruitment/cycles/${cycleId}/dual-appointments`;
}

const ACTIVE = ACTIVE_DUAL_APPOINTMENT_STATUSES as DualAppointmentStatus[];

/** What becomes of the roster when a dual appointment is approved. */
export type RosterOutcome =
  /** Already promoted, and now on the second roster too. */
  | "added"
  /** Not promoted yet: promotion puts them on both rosters. */
  | "at_promotion"
  /** Already promoted, but the second membership could not be written. */
  | "failed";

/**
 * The APPROVED dual appointments for a cycle or a set of applications, in the
 * shape findAcceptanceConflicts takes. Every surface that asks "is this a
 * conflict" reads its approvals through here.
 */
export async function approvedDualAppointmentPairs(where: {
  cycleId?: string;
  applicationIds?: string[];
}): Promise<Array<{ applicationId: string; departmentCode: string }>> {
  if (where.applicationIds && where.applicationIds.length === 0) return [];
  return prisma.dualAppointment.findMany({
    where: {
      status: "APPROVED",
      ...(where.applicationIds ? { applicationId: { in: where.applicationIds } } : {}),
      ...(where.cycleId ? { application: { cycleId: where.cycleId } } : {}),
    },
    select: { applicationId: true, departmentCode: true },
  });
}

const APPLICATION_SELECT = {
  id: true,
  cycleId: true,
  status: true,
  routedDepartmentCode: true,
  departmentChoices: true,
  answers: true,
  cycle: {
    select: { id: true, title: true, track: true, status: true, termId: true, term: { select: { clinicDates: true } } },
  },
  applicant: { select: { firstName: true, lastName: true, applicantPersonId: true } },
  acceptances: {
    select: {
      id: true,
      departmentCode: true,
      emailedAt: true,
      contract: { select: { id: true, status: true, promotedPersonId: true } },
    },
  },
  dualAppointments: { select: { id: true, departmentCode: true, status: true } },
} satisfies Prisma.ApplicationSelect;

type DualApplication = Prisma.ApplicationGetPayload<{ select: typeof APPLICATION_SELECT }>;

function applicantName(app: { applicant: { firstName: string; lastName: string } }): string {
  return `${app.applicant.firstName} ${app.applicant.lastName}`.trim();
}

function assertAppointable(app: DualApplication | null | undefined): asserts app is DualApplication {
  if (!app) throw new DualAppointmentError("Application not found.");
  if (app.status !== "SUBMITTED") throw new DualAppointmentError("This application is no longer active.");
  if (app.cycle.track !== "VOLUNTEER") {
    throw new DualAppointmentError("Dual appointments apply to volunteer cycles.");
  }
  if (app.cycle.status === "DRAFT" || app.cycle.status === "ARCHIVED") {
    throw new DualAppointmentError("Dual appointments can only be made on an open or closed cycle.");
  }
}

/**
 * Refuse when this dual appointment would put the person in more departments
 * than the cap allows, or when two departments accepted them with no dual
 * appointment behind it.
 *
 * "In play" counts what the application is routed to, every department that has
 * accepted it, and every dual appointment still standing (pending or approved),
 * plus the one being asked for. `ignoreId` leaves out the row being decided, so
 * approving a request does not count it twice.
 */
function assertRoomFor(app: DualApplication, departmentCode: string, ignoreId?: string): void {
  const others = app.dualAppointments
    .filter((d) => d.id !== ignoreId && d.departmentCode !== departmentCode && ACTIVE.includes(d.status))
    .map((d) => d.departmentCode);
  const accepted = [...new Set(app.acceptances.map((a) => a.departmentCode))];
  const inPlay = new Set<string>([
    ...(app.routedDepartmentCode ? [app.routedDepartmentCode] : []),
    ...accepted,
    ...others,
    departmentCode,
  ]);
  if (inPlay.size > MAX_APPOINTED_DEPARTMENTS) {
    const already = [...inPlay].filter((c) => c !== departmentCode).sort().join(", ");
    throw new DualAppointmentError(
      `That would put them in ${inPlay.size} departments (${already}, and ${departmentCode}). A volunteer can serve in ${MAX_APPOINTED_DEPARTMENTS} departments at most.`,
    );
  }
  // Every dual appointment in play counts as approved here: the question this
  // asks is whether TWO departments accepted them with nothing agreed behind it.
  if (isAcceptanceConflict([...accepted, departmentCode], [...others, departmentCode])) {
    throw new DualAppointmentError(
      `They are already accepted by ${accepted.filter((c) => c !== departmentCode).join(" and ")}. Resolve that on the Decisions page first.`,
    );
  }
}

/**
 * Serialize everything that adds a department to one application.
 *
 * The cap is "at most N departments", which no unique index can express, so the
 * Application row is what two callers contend on instead. Without this lock two
 * concurrent requests could each read one department in play and each write the
 * one that tips it over. Re-reads the dual appointments inside the lock and
 * re-runs the cap check against them, because the caller's copy was read before
 * the transaction began.
 */
async function lockAndRecheck(
  tx: TransactionClient,
  app: DualApplication,
  departmentCode: string,
  ignoreId?: string,
): Promise<void> {
  await tx.$queryRaw`SELECT id FROM "Application" WHERE id = ${app.id} FOR UPDATE`;
  const live = await tx.dualAppointment.findMany({
    where: { applicationId: app.id, status: { in: ACTIVE } },
    select: { id: true, departmentCode: true, status: true },
  });
  assertRoomFor({ ...app, dualAppointments: live }, departmentCode, ignoreId);
}

async function activeDepartment(code: string): Promise<{ id: string; code: string; name: string }> {
  const department = await prisma.department.findUnique({
    where: { code },
    select: { id: true, code: true, name: true, isActive: true },
  });
  if (!department?.isActive) throw new DualAppointmentError("Choose an active department.");
  return department;
}

async function assertManager(actorId: string, verb: string): Promise<void> {
  if (!(await can(actorId, DUAL_APPOINTMENT_MANAGER_PERMISSION))) {
    throw new RecruitmentAuthError(`Only a recruitment manager can ${verb} dual appointments.`);
  }
}

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
}

function trimmed(value: string | null | undefined): string | null {
  return value?.trim() || null;
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/**
 * Ask for a volunteer as a dual appointment, or, for a recruitment manager, add
 * one outright.
 *
 * A director may ask only for a department they direct, and must say why. A
 * manager may add any active department; if a director already asked for that
 * department, the manager's add is the approval of that request.
 */
export async function requestDualAppointment(
  actorId: string,
  input: { applicationId: string; departmentCode: string; reason?: string | null; cycleId?: string },
): Promise<{ id: string; status: "PENDING" | "APPROVED"; roster: RosterOutcome | null }> {
  const departmentCode = input.departmentCode.trim();
  const reason = trimmed(input.reason);
  const app = await prisma.application.findUnique({ where: { id: input.applicationId }, select: APPLICATION_SELECT });
  // A page scoped to one cycle must not act on another cycle's application.
  if (app && input.cycleId && app.cycleId !== input.cycleId) throw new DualAppointmentError("Application not found.");
  assertAppointable(app);

  const scope = await reviewScope(actorId);
  const isManager = scope.all;
  if (!isManager && !scope.departmentCodes.includes(departmentCode)) {
    throw new RecruitmentAuthError("You can only ask for volunteers for a department you direct.");
  }
  if (app.applicant.applicantPersonId === actorId) {
    throw new RecruitmentAuthError("You can't request a dual appointment on your own application.");
  }
  const department = await activeDepartment(departmentCode);
  if (app.routedDepartmentCode === departmentCode) {
    throw new DualAppointmentError(`This application is already routed to ${departmentCode}.`);
  }
  if (!isManager && !reason) {
    throw new DualAppointmentError("Say why your department wants them. A recruitment manager reads it before approving.");
  }

  const existing = app.dualAppointments.find((d) => d.departmentCode === departmentCode);
  if (existing?.status === "APPROVED") {
    throw new DualAppointmentError(`They already have an approved dual appointment with ${departmentCode}.`);
  }
  if (existing?.status === "PENDING") {
    if (!isManager) {
      throw new DualAppointmentError(`A request for ${departmentCode} is already waiting for a recruitment manager.`);
    }
    const approved = await approveDualAppointment(actorId, existing.id, reason);
    return { id: existing.id, status: "APPROVED", roster: approved.roster };
  }
  assertRoomFor(app, departmentCode);

  const status = isManager ? "APPROVED" : "PENDING";
  const data = {
    status,
    reason,
    requestedById: actorId,
    decidedById: isManager ? actorId : null,
    decidedAt: isManager ? new Date() : null,
    decisionNote: null,
  } as const;
  let id: string;
  try {
    id = await prisma.$transaction(async (tx) => {
      await lockAndRecheck(tx, app, departmentCode);
      // A declined or cancelled row for this department is reused: the pair is
      // unique, and its history lives in the audit log. Upserted on that pair so
      // a concurrent request for the SAME department cannot raise a duplicate.
      const row = await tx.dualAppointment.upsert({
        where: { applicationId_departmentCode: { applicationId: app.id, departmentCode } },
        update: data,
        create: { ...data, applicationId: app.id, departmentCode },
      });
      if (isManager) {
        await tx.acceptance.createMany({
          data: [{ applicationId: app.id, departmentCode, approvedById: actorId, notes: DUAL_APPOINTMENT_ACCEPTANCE_NOTE }],
          skipDuplicates: true,
        });
      }
      return row.id;
    });
  } catch (err) {
    // Defensive: the upsert above closes the ordinary race on the unique
    // (applicationId, departmentCode) pair, so this only fires if one slips past.
    if (isUniqueViolation(err)) {
      throw new DualAppointmentError(`A dual appointment for ${departmentCode} was just created. Refresh and try again.`);
    }
    throw err;
  }

  await recordAudit({
    actorPersonId: actorId,
    action: isManager ? "recruitment.dual_appointment_added" : "recruitment.dual_appointment_requested",
    entityType: "DualAppointment",
    entityId: id,
    after: { applicationId: app.id, departmentCode, status, reason },
  });

  if (isManager) {
    return { id, status, roster: await addToRosterIfPromoted(actorId, app, department) };
  }
  await notifyManagersOfRequest(actorId, app, department.name, reason);
  return { id, status, roster: null };
}

/** A recruitment manager approves a director's request. Mints the acceptance. */
export async function approveDualAppointment(
  actorId: string,
  dualAppointmentId: string,
  note?: string | null,
): Promise<{ roster: RosterOutcome }> {
  await assertManager(actorId, "approve");
  const row = await prisma.dualAppointment.findUnique({
    where: { id: dualAppointmentId },
    select: { id: true, status: true, departmentCode: true, requestedById: true, application: { select: APPLICATION_SELECT } },
  });
  if (!row) throw new DualAppointmentError("That dual appointment no longer exists.");
  if (row.status !== "PENDING") throw new DualAppointmentError("That request has already been decided.");
  const app = row.application;
  assertAppointable(app);
  if (app.applicant.applicantPersonId === actorId) {
    throw new RecruitmentAuthError("You can't approve a dual appointment on your own application.");
  }
  if (app.routedDepartmentCode === row.departmentCode) {
    throw new DualAppointmentError(
      `This application has since been routed to ${row.departmentCode}, so there is nothing to approve. Decline the request.`,
    );
  }
  const department = await activeDepartment(row.departmentCode);
  assertRoomFor(app, row.departmentCode, row.id);
  const decisionNote = trimmed(note);

  await prisma.$transaction(async (tx) => {
    // Approving adds a department, so it takes the same lock as a request: two
    // approvals racing could otherwise both pass the check taken above.
    await lockAndRecheck(tx, app, row.departmentCode, row.id);
    const claimed = await tx.dualAppointment.updateMany({
      where: { id: row.id, status: "PENDING" },
      data: { status: "APPROVED", decidedById: actorId, decidedAt: new Date(), decisionNote },
    });
    if (claimed.count === 0) {
      throw new DualAppointmentError("That request was just decided by someone else. Refresh and try again.");
    }
    await tx.acceptance.createMany({
      data: [{ applicationId: app.id, departmentCode: row.departmentCode, approvedById: actorId, notes: DUAL_APPOINTMENT_ACCEPTANCE_NOTE }],
      skipDuplicates: true,
    });
  });

  await recordAudit({
    actorPersonId: actorId,
    action: "recruitment.dual_appointment_approved",
    entityType: "DualAppointment",
    entityId: row.id,
    after: { applicationId: app.id, departmentCode: row.departmentCode, note: decisionNote },
  });
  const roster = await addToRosterIfPromoted(actorId, app, department);
  await notifyRequesterOfDecision(actorId, {
    requestedById: row.requestedById,
    app,
    departmentName: department.name,
    outcome: "approved",
    note: decisionNote,
  });
  return { roster };
}

/** A recruitment manager declines a director's request. */
export async function declineDualAppointment(
  actorId: string,
  dualAppointmentId: string,
  note?: string | null,
): Promise<void> {
  await assertManager(actorId, "decline");
  const row = await prisma.dualAppointment.findUnique({
    where: { id: dualAppointmentId },
    select: { id: true, status: true, departmentCode: true, requestedById: true, application: { select: APPLICATION_SELECT } },
  });
  if (!row) throw new DualAppointmentError("That dual appointment no longer exists.");
  if (row.status !== "PENDING") throw new DualAppointmentError("That request has already been decided.");
  const decisionNote = trimmed(note);
  const claimed = await prisma.dualAppointment.updateMany({
    where: { id: row.id, status: "PENDING" },
    data: { status: "DECLINED", decidedById: actorId, decidedAt: new Date(), decisionNote },
  });
  if (claimed.count === 0) {
    throw new DualAppointmentError("That request was just decided by someone else. Refresh and try again.");
  }
  await recordAudit({
    actorPersonId: actorId,
    action: "recruitment.dual_appointment_declined",
    entityType: "DualAppointment",
    entityId: row.id,
    after: { applicationId: row.application.id, departmentCode: row.departmentCode, note: decisionNote },
  });
  const department = await prisma.department.findUnique({ where: { code: row.departmentCode }, select: { name: true } });
  await notifyRequesterOfDecision(actorId, {
    requestedById: row.requestedById,
    app: row.application,
    departmentName: department?.name ?? row.departmentCode,
    outcome: "declined",
    note: decisionNote,
  });
}

/**
 * Withdraw a pending request, or undo an approval.
 *
 * A pending request can be withdrawn by a manager or by a director of the
 * department that asked. An approval can only be undone by a manager, and only
 * while the second acceptance is still just an acceptance: once it carries the
 * onboarding contract, or the person is on the roster, there is real data
 * behind it and the undo has to go through Onboarding or the term roster.
 */
export async function cancelDualAppointment(
  actorId: string,
  dualAppointmentId: string,
  note?: string | null,
): Promise<void> {
  const row = await prisma.dualAppointment.findUnique({
    where: { id: dualAppointmentId },
    select: { id: true, status: true, departmentCode: true, requestedById: true, application: { select: APPLICATION_SELECT } },
  });
  if (!row) throw new DualAppointmentError("That dual appointment no longer exists.");
  const app = row.application;
  const scope = await reviewScope(actorId);
  const acceptance = app.acceptances.find((a) => a.departmentCode === row.departmentCode);

  if (row.status === "PENDING") {
    if (!scope.all && !scope.departmentCodes.includes(row.departmentCode)) {
      throw new RecruitmentAuthError(`Only a recruitment manager or a ${row.departmentCode} director can withdraw this request.`);
    }
  } else if (row.status === "APPROVED") {
    if (!scope.all) throw new RecruitmentAuthError("Only a recruitment manager can cancel an approved dual appointment.");
    if (acceptance?.contract) {
      throw new DualAppointmentError(
        `Their onboarding form went out through the ${row.departmentCode} acceptance. Withdraw that contract on the Onboarding page first.`,
      );
    }
    if (app.acceptances.some((a) => a.contract?.status === "PROMOTED")) {
      throw new DualAppointmentError(
        `They are already on the ${row.departmentCode} roster. Remove that membership from the term roster instead.`,
      );
    }
  } else {
    throw new DualAppointmentError("That dual appointment is not in play.");
  }

  const decisionNote = trimmed(note);
  await prisma.$transaction(async (tx) => {
    const claimed = await tx.dualAppointment.updateMany({
      where: { id: row.id, status: row.status },
      data: { status: "CANCELLED", decidedById: actorId, decidedAt: new Date(), decisionNote },
    });
    if (claimed.count === 0) {
      throw new DualAppointmentError("That dual appointment just changed. Refresh and try again.");
    }
    if (row.status === "APPROVED" && acceptance) {
      // Only while it still has no contract: one created since the read above
      // makes this remove nothing, and the whole cancel rolls back.
      const removed = await tx.acceptance.deleteMany({ where: { id: acceptance.id, contract: { is: null } } });
      if (removed.count === 0) {
        throw new DualAppointmentError(
          `Their onboarding form went out through the ${row.departmentCode} acceptance. Withdraw that contract on the Onboarding page first.`,
        );
      }
    }
  });

  await recordAudit({
    actorPersonId: actorId,
    action: "recruitment.dual_appointment_cancelled",
    entityType: "DualAppointment",
    entityId: row.id,
    before: { status: row.status },
    after: { applicationId: app.id, departmentCode: row.departmentCode, note: decisionNote, acceptanceRemoved: row.status === "APPROVED" && acceptance != null },
  });
  if (row.requestedById !== actorId) {
    const department = await prisma.department.findUnique({ where: { code: row.departmentCode }, select: { name: true } });
    await notifyRequesterOfDecision(actorId, {
      requestedById: row.requestedById,
      app,
      departmentName: department?.name ?? row.departmentCode,
      outcome: "cancelled",
      note: decisionNote,
    });
  }
}

/**
 * Put an already-promoted volunteer on the second department's roster.
 *
 * Promotion is what normally does this, so the only time it runs here is when
 * the approval lands after promotion. Best-effort in the sense that the approval
 * has already committed: a failure (the person has since been offboarded) is
 * logged and reported back, never thrown past the approval.
 */
async function addToRosterIfPromoted(
  actorId: string,
  app: DualApplication,
  department: { id: string; code: string },
): Promise<RosterOutcome> {
  const personId = app.acceptances.find((a) => a.contract?.status === "PROMOTED")?.contract?.promotedPersonId;
  if (!personId) return "at_promotion";
  try {
    await addMembership(actorId, {
      personId,
      termId: app.cycle.termId,
      departmentId: department.id,
      kind: "VOLUNTEER",
    });
    const availability = applicationAvailabilityDates(app.answers, app.cycle.term.clinicDates);
    const acceptance = await prisma.acceptance.findUnique({
      where: { applicationId_departmentCode: { applicationId: app.id, departmentCode: department.code } },
      select: { id: true },
    });
    await prisma.$transaction(async (tx) => {
      // The same baseline promotion writes, and only where none is set, so a
      // membership that existed already keeps whatever it had.
      if (availability.length > 0) {
        await tx.termMembership.updateMany({
          where: {
            personId, termId: app.cycle.termId, departmentId: department.id, kind: "VOLUNTEER",
            baselineAvailability: { isEmpty: true },
          },
          data: { baselineAvailability: availability },
        });
      }
      if (acceptance) await adoptIncomingShiftsTx(tx, { acceptanceId: acceptance.id, personId });
    });
    return "added";
  } catch (err) {
    log.error(
      "[dual-appointments] approved, but adding the second membership failed",
      errorAttrs(err, { applicationId: app.id, departmentCode: department.code }),
    );
    return "failed";
  }
}

// ---------------------------------------------------------------------------
// Notifications. After the write has committed, and best-effort: a delivery
// failure must never read as a failed request or decision.
// ---------------------------------------------------------------------------

async function notifyManagersOfRequest(
  actorId: string,
  app: DualApplication,
  departmentName: string,
  reason: string | null,
): Promise<void> {
  try {
    const [holders, baseUrl, requester, primary] = await Promise.all([
      peopleWithPermission(DUAL_APPOINTMENT_MANAGER_PERMISSION),
      getSetting<string>("app.baseUrl"),
      prisma.person.findUnique({ where: { id: actorId }, select: { name: true } }),
      app.routedDepartmentCode
        ? prisma.department.findUnique({ where: { code: app.routedDepartmentCode }, select: { name: true } })
        : null,
    ]);
    const reviewLink = `${baseUrl}${dualAppointmentsPath(app.cycleId)}`;
    const name = applicantName(app);
    for (const holder of holders) {
      if (holder.id === actorId) continue;
      const rendered = await renderEmail("recruitment.dual_appointment_requested", {
        firstName: firstNameOf(holder.name) || "there",
        requesterName: requester?.name ?? "A director",
        applicantName: name,
        departmentName,
        primaryDepartmentName: primary?.name ?? app.routedDepartmentCode ?? "",
        cycleTitle: app.cycle.title,
        reason: reason ?? "",
        reviewLink,
      });
      await notify(prisma, {
        type: "recruitment.dual_appointment_requested",
        person: holder,
        email: rendered,
        teams: { title: `Dual appointment requested for ${departmentName}`, summary: `${name}: ${reason ?? ""}`.trim(), link: reviewLink },
        triggeredById: actorId,
      });
    }
  } catch (err) {
    log.error("[dual-appointments] failed to notify recruitment managers", errorAttrs(err, { applicationId: app.id }));
  }
}

async function notifyRequesterOfDecision(
  actorId: string,
  input: {
    requestedById: string;
    app: { id: string; cycleId: string; cycle: { title: string }; applicant: { firstName: string; lastName: string } };
    departmentName: string;
    outcome: "approved" | "declined" | "cancelled";
    note: string | null;
  },
): Promise<void> {
  if (input.requestedById === actorId) return;
  try {
    const [requester, baseUrl] = await Promise.all([
      prisma.person.findUnique({
        where: { id: input.requestedById },
        select: { id: true, name: true, contactEmail: true, entraObjectId: true },
      }),
      getSetting<string>("app.baseUrl"),
    ]);
    if (!requester) return;
    const reviewLink = `${baseUrl}${dualAppointmentsPath(input.app.cycleId)}`;
    const name = applicantName(input.app);
    const rendered = await renderEmail("recruitment.dual_appointment_decided", {
      firstName: firstNameOf(requester.name) || "there",
      applicantName: name,
      departmentName: input.departmentName,
      cycleTitle: input.app.cycle.title,
      outcome: input.outcome,
      isApproved: input.outcome === "approved",
      note: input.note ?? "",
      reviewLink,
    });
    await notify(prisma, {
      type: "recruitment.dual_appointment_decided",
      person: requester,
      email: rendered,
      teams: { title: `Dual appointment ${input.outcome}`, summary: `${name} in ${input.departmentName}`, link: reviewLink },
      triggeredById: actorId,
    });
  } catch (err) {
    log.error("[dual-appointments] failed to notify the requester", errorAttrs(err, { applicationId: input.app.id }));
  }
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export type DualAppointmentRow = {
  id: string;
  applicationId: string;
  applicantName: string;
  legalFirstName: string;
  lastName: string;
  /** False once the applicant withdrew. */
  applicationActive: boolean;
  routedDepartmentCode: string | null;
  departmentCode: string;
  departmentName: string;
  status: DualAppointmentStatus;
  reason: string | null;
  requestedByName: string;
  requestedAt: Date;
  decidedByName: string | null;
  decidedAt: Date | null;
  decisionNote: string | null;
  /** How far the application's onboarding has got. */
  onboarding: "NOT_SENT" | "IN_PROGRESS" | "ON_ROSTER";
  canOpenApplication: boolean;
  canDecide: boolean;
  canCancel: boolean;
};

/**
 * A cycle's dual appointments, as the viewer may see them. A recruitment
 * manager sees all of them. A director sees the ones asking for their
 * department and the ones asking to share a volunteer routed to it, since both
 * are their business. Anyone else sees none.
 */
export async function listDualAppointments(
  opts: { cycleId: string; applicationId?: string },
  viewerId: string,
): Promise<DualAppointmentRow[]> {
  const [scope, managesCycles, canScore] = await Promise.all([
    reviewScope(viewerId),
    can(viewerId, "recruitment.manage_cycles"),
    can(viewerId, "recruitment.score"),
  ]);
  if (!scope.all && scope.departmentCodes.length === 0) return [];
  const rows = await prisma.dualAppointment.findMany({
    where: {
      application: { cycleId: opts.cycleId },
      ...(opts.applicationId ? { applicationId: opts.applicationId } : {}),
      ...(scope.all
        ? {}
        : {
            OR: [
              { departmentCode: { in: scope.departmentCodes } },
              { application: { routedDepartmentCode: { in: scope.departmentCodes } } },
            ],
          }),
    },
    select: {
      id: true,
      departmentCode: true,
      status: true,
      reason: true,
      createdAt: true,
      decidedAt: true,
      decisionNote: true,
      requestedBy: { select: { name: true } },
      decidedBy: { select: { name: true } },
      application: {
        select: {
          id: true,
          status: true,
          routedDepartmentCode: true,
          departmentChoices: true,
          cycle: { select: { track: true } },
          applicant: { select: { firstName: true, lastName: true } },
          acceptances: { select: { contract: { select: { status: true } } } },
          dualAppointments: { select: { departmentCode: true, status: true } },
        },
      },
    },
    orderBy: [{ status: "asc" }, { createdAt: "desc" }],
  });
  const departments = await prisma.department.findMany({
    where: { code: { in: [...new Set(rows.map((r) => r.departmentCode))] } },
    select: { code: true, name: true },
  });
  const nameByCode = new Map(departments.map((d) => [d.code, d.name]));

  return rows.map((r) => {
    const app = r.application;
    const contracts = app.acceptances.flatMap((a) => (a.contract ? [a.contract.status] : []));
    const onboarding = contracts.includes("PROMOTED") ? "ON_ROSTER" : contracts.length > 0 ? "IN_PROGRESS" : "NOT_SENT";
    const mine = scope.departmentCodes.includes(r.departmentCode);
    return {
      id: r.id,
      applicationId: app.id,
      applicantName: applicantName(app),
      legalFirstName: app.applicant.firstName,
      lastName: app.applicant.lastName,
      applicationActive: app.status === "SUBMITTED",
      routedDepartmentCode: app.routedDepartmentCode,
      departmentCode: r.departmentCode,
      departmentName: nameByCode.get(r.departmentCode) ?? r.departmentCode,
      status: r.status,
      reason: r.reason,
      requestedByName: r.requestedBy.name,
      requestedAt: r.createdAt,
      decidedByName: r.decidedBy?.name ?? null,
      decidedAt: r.decidedAt,
      decisionNote: r.decisionNote,
      onboarding,
      canOpenApplication: canViewApplication(app, { scope, managesCycles, canScore }),
      canDecide: scope.all && r.status === "PENDING" && app.status === "SUBMITTED",
      canCancel:
        (r.status === "PENDING" && (scope.all || mine)) ||
        (r.status === "APPROVED" && scope.all && onboarding !== "ON_ROSTER"),
    };
  });
}

export type DualAppointmentSuggestion = {
  applicationId: string;
  applicantName: string;
  legalFirstName: string;
  lastName: string;
  /** Where the application is headed, or null while it is unrouted. */
  routedDepartmentCode: string | null;
  departmentChoices: string[];
  /** The viewer's department this volunteer already serves in. */
  departmentCode: string;
};

/**
 * Volunteers already serving in a department the viewer directs, whose
 * application this cycle went to a different department.
 *
 * This is the case dual appointments exist for in practice: someone serving in
 * two departments renews, the renewal form takes one department, and the other
 * department wants to keep them. Listing them saves the director from having to
 * notice. "Already serving" means a VOLUNTEER membership in the live term or the
 * cycle's own term.
 */
export async function listDualAppointmentSuggestions(
  cycleId: string,
  viewerId: string,
): Promise<DualAppointmentSuggestion[]> {
  const scope = await reviewScope(viewerId);
  if (scope.departmentCodes.length === 0) return [];
  const cycle = await prisma.recruitmentCycle.findUnique({ where: { id: cycleId }, select: { termId: true, track: true } });
  if (!cycle || cycle.track !== "VOLUNTEER") return [];
  const live = await getActiveTerm();
  const termIds = [...new Set([cycle.termId, ...(live ? [live.id] : [])])];

  const memberships = await prisma.termMembership.findMany({
    where: {
      termId: { in: termIds },
      status: "ACTIVE",
      kind: "VOLUNTEER",
      department: { code: { in: scope.departmentCodes } },
    },
    select: { personId: true, department: { select: { code: true } } },
  });
  const servingIn = new Map<string, Set<string>>();
  for (const m of memberships) {
    if (m.personId === viewerId) continue;
    servingIn.set(m.personId, (servingIn.get(m.personId) ?? new Set()).add(m.department.code));
  }
  if (servingIn.size === 0) return [];

  const apps = await prisma.application.findMany({
    where: { cycleId, status: "SUBMITTED", applicant: { applicantPersonId: { in: [...servingIn.keys()] } } },
    select: {
      id: true,
      routedDepartmentCode: true,
      departmentChoices: true,
      applicant: { select: { firstName: true, lastName: true, applicantPersonId: true } },
      acceptances: { select: { departmentCode: true } },
      dualAppointments: { select: { departmentCode: true, status: true } },
    },
  });

  const out: DualAppointmentSuggestion[] = [];
  for (const app of apps) {
    const personId = app.applicant.applicantPersonId;
    if (!personId) continue;
    // Rules them out only once the cap is reached: below it another department
    // may still ask. A department already in play is skipped per code below.
    const inPlay = app.dualAppointments.filter((d) => ACTIVE.includes(d.status)).map((d) => d.departmentCode);
    if ((app.routedDepartmentCode ? 1 : 0) + inPlay.length >= MAX_APPOINTED_DEPARTMENTS) continue;
    for (const code of servingIn.get(personId) ?? []) {
      if (app.routedDepartmentCode === code) continue;
      if (inPlay.includes(code)) continue;
      // Still unrouted but they chose this department: routing will likely send
      // them here anyway, so it is not a second department yet.
      if (!app.routedDepartmentCode && app.departmentChoices.includes(code)) continue;
      if (app.acceptances.some((a) => a.departmentCode === code)) continue;
      out.push({
        applicationId: app.id,
        applicantName: applicantName(app),
        legalFirstName: app.applicant.firstName,
        lastName: app.applicant.lastName,
        routedDepartmentCode: app.routedDepartmentCode,
        departmentChoices: app.departmentChoices,
        departmentCode: code,
      });
    }
  }
  return out.sort(comparePersonName);
}

/**
 * Find the active application in a cycle by the applicant's email or NetID, for
 * a director asking for somebody who is not in their suggestions. An exact
 * match only: directors do not otherwise see applications outside their
 * department, and this should not become a way to browse them.
 */
export async function findApplicationByEmailOrNetId(
  cycleId: string,
  query: string,
): Promise<{ id: string } | null> {
  const q = query.trim().toLowerCase();
  if (!q) return null;
  return prisma.application.findFirst({
    where: {
      cycleId,
      status: "SUBMITTED",
      applicant: { OR: [{ emailLower: q }, { netId: { equals: q, mode: "insensitive" } }] },
    },
    select: { id: true },
  });
}

/** Every active application in a cycle, for a recruitment manager's picker. */
export async function listDualAppointmentApplicantOptions(
  cycleId: string,
  viewerId: string,
): Promise<Array<{ applicationId: string; label: string }>> {
  if (!(await can(viewerId, DUAL_APPOINTMENT_MANAGER_PERMISSION))) return [];
  const apps = await prisma.application.findMany({
    where: { cycleId, status: "SUBMITTED", cycle: { track: "VOLUNTEER" } },
    select: { id: true, routedDepartmentCode: true, applicant: { select: { firstName: true, lastName: true, email: true } } },
  });
  return apps
    .map((a) => ({
      applicationId: a.id,
      legalFirstName: a.applicant.firstName,
      lastName: a.applicant.lastName,
      label: `${applicantName(a)} (${a.applicant.email})${a.routedDepartmentCode ? `, routed to ${a.routedDepartmentCode}` : ", not routed"}`,
    }))
    .sort(comparePersonName)
    .map(({ applicationId, label }) => ({ applicationId, label }));
}
