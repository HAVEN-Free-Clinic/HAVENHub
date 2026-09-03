/**
 * Attendance events: taking a sign-in sheet for anything the clinic runs.
 *
 * This generalizes what used to be a single button on the training roster
 * (recordAttendance in ./training.ts), which could only ever credit someone who
 * already held an ACTIVE TermMembership of the cycle's track. That constraint
 * made two real situations unrecordable:
 *
 *   - Info sessions, attended almost entirely by prospective applicants who have
 *     no Person row at all. Attendance was self-attested on the application
 *     instead, which was unenforceable; the sheet is the source of truth.
 *   - Training attended by someone who has not finished onboarding. Their
 *     membership is created by promotion (services/promotion.ts) when the
 *     onboarding contract is submitted, which routinely happens AFTER the
 *     session they physically sat in.
 *
 * So attendance here is recorded against the event, and the training completion
 * is a CONSEQUENCE of it rather than the storage for it:
 *
 *   recordEventCheckIn -> EventAttendance row (always)
 *                      -> completeTraining(via ATTENDANCE) when kind = TRAINING
 *                         and the attendee has a Person, membership or not
 *                      -> nudge email when anything is still outstanding
 *
 * Training is keyed (personId, termId, track), so a completion written for
 * someone with no membership sits there harmlessly and starts counting the
 * moment promotion gives them one. A walk-up with no Person cannot have one
 * written yet; linkAttendee backfills it when the row is matched to a person.
 *
 * Every mutation is idempotent. Two staffers working the same door, a
 * double-tapped button, or a retried server action must not write two rows or
 * send two emails -- which is what the pair of unique constraints on
 * EventAttendance (see the schema comment) is for.
 */

import type {
  AttendanceEvent,
  AttendanceEventKind,
  EventAttendance,
  Prisma,
  Track,
} from "@prisma/client";
import { prisma, isUniqueConstraintError } from "@/platform/db";
import { can } from "@/platform/rbac/engine";
import { recordAudit } from "@/platform/audit";
import { log, errorAttrs } from "@/platform/logging";
import { RecruitmentAuthError, reviewScope } from "./review";
import { completeTraining } from "./training";
import {
  resolveAttendanceBlockers,
  NO_BLOCKERS,
  WALK_UP_BLOCKERS,
  type AttendanceBlockers,
} from "@/platform/compliance/attendance-blockers";
import { sendAttendanceNudge } from "@/platform/email/attendance-nudges";

export class AttendanceEventError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AttendanceEventError";
  }
}

// ---------------------------------------------------------------------------
// Authority
// ---------------------------------------------------------------------------

/**
 * Who a viewer may check in.
 *
 * `all` is the door-staff shape: one person on the door marks everybody present,
 * including walk-ups nobody has a record for. It comes from the dedicated
 * (unscoped) recruitment.record_attendance permission, or from the two broad
 * recruitment permissions whose holders already act clinic-wide.
 *
 * A department-scoped director gets `departmentCodes` instead, which preserves
 * exactly the rule recordAttendance enforced before this module existed: you may
 * credit a member of a department you manage, and nobody else. They cannot add
 * walk-ups, because a walk-up has no department to check them against -- an
 * unlinked row is a clinic-wide assertion, not a departmental one.
 */
export type AttendanceAuthority = { all: boolean; departmentCodes: string[] };

export async function resolveAttendanceAuthority(actorId: string): Promise<AttendanceAuthority> {
  const [recordAll, managesCycles, scope] = await Promise.all([
    can(actorId, "recruitment.record_attendance"),
    can(actorId, "recruitment.manage_cycles"),
    reviewScope(actorId),
  ]);
  return {
    all: recordAll || managesCycles || scope.all,
    departmentCodes: scope.departmentCodes,
  };
}

/** May this viewer record attendance at all (on any scope)? Gates the nav tab. */
export async function canRecordAttendance(actorId: string): Promise<boolean> {
  const authority = await resolveAttendanceAuthority(actorId);
  return authority.all || authority.departmentCodes.length > 0;
}

async function requireEventManager(actorId: string): Promise<void> {
  if (!(await can(actorId, "recruitment.manage_cycles"))) {
    throw new RecruitmentAuthError("Only recruitment leads can create or change events.");
  }
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export type EventInput = {
  termId: string;
  cycleId: string | null;
  kind: AttendanceEventKind;
  title: string;
  startsAt: Date;
  endsAt: Date | null;
  location: string | null;
  notes: string | null;
};

/** Normalize and validate an event's fields. Shared by create and update. */
function validateEventInput(input: EventInput): EventInput {
  const title = input.title.trim();
  if (title.length === 0) throw new AttendanceEventError("Give the event a title.");
  if (Number.isNaN(input.startsAt.getTime())) {
    throw new AttendanceEventError("Give the event a valid start date and time.");
  }
  if (input.endsAt && input.endsAt.getTime() < input.startsAt.getTime()) {
    throw new AttendanceEventError("The event cannot end before it starts.");
  }
  // A TRAINING event's cycle is what carries the track its check-ins complete
  // training for, so an event without one could record attendance that silently
  // credits nothing. The schema cannot express a conditional requirement.
  if (input.kind === "TRAINING" && !input.cycleId) {
    throw new AttendanceEventError("A training event must belong to a recruitment cycle.");
  }
  return {
    ...input,
    title,
    location: input.location?.trim() || null,
    notes: input.notes?.trim() || null,
  };
}

export async function createEvent(input: EventInput, actorId: string): Promise<AttendanceEvent> {
  await requireEventManager(actorId);
  const clean = validateEventInput(input);

  if (clean.cycleId) {
    const cycle = await prisma.recruitmentCycle.findUnique({
      where: { id: clean.cycleId },
      select: { termId: true },
    });
    if (!cycle) throw new AttendanceEventError("Cycle not found.");
    // The cycle's term wins over a mismatched termId rather than erroring: the
    // pair must agree or "was this person at training this term?" gets two
    // different answers depending on which column the reader trusts.
    if (cycle.termId !== clean.termId) clean.termId = cycle.termId;
  }

  const event = await prisma.attendanceEvent.create({
    data: { ...clean, createdById: actorId },
  });
  await recordAudit({
    actorPersonId: actorId,
    action: "recruitment.event_created",
    entityType: "AttendanceEvent",
    entityId: event.id,
    after: { kind: event.kind, title: event.title, startsAt: event.startsAt, cycleId: event.cycleId },
  });
  return event;
}

export async function updateEvent(
  eventId: string,
  input: Omit<EventInput, "termId" | "cycleId" | "kind">,
  actorId: string,
): Promise<AttendanceEvent> {
  await requireEventManager(actorId);
  const existing = await prisma.attendanceEvent.findUnique({ where: { id: eventId } });
  if (!existing) throw new AttendanceEventError("Event not found.");
  // Kind, cycle and term are deliberately immutable: attendance rows already
  // written under this event were credited (or not) according to its kind, and
  // flipping an INFO_SESSION into a TRAINING afterwards would claim training
  // completions that were never recorded. Delete and re-create instead.
  const clean = validateEventInput({
    ...input,
    termId: existing.termId,
    cycleId: existing.cycleId,
    kind: existing.kind,
  });
  const event = await prisma.attendanceEvent.update({
    where: { id: eventId },
    data: {
      title: clean.title,
      startsAt: clean.startsAt,
      endsAt: clean.endsAt,
      location: clean.location,
      notes: clean.notes,
    },
  });
  await recordAudit({
    actorPersonId: actorId,
    action: "recruitment.event_updated",
    entityType: "AttendanceEvent",
    entityId: eventId,
    before: { title: existing.title, startsAt: existing.startsAt, location: existing.location },
    after: { title: event.title, startsAt: event.startsAt, location: event.location },
  });
  return event;
}

/** Delete an event. Refuses once attendance exists: that is a record, not a draft. */
export async function deleteEvent(eventId: string, actorId: string): Promise<void> {
  await requireEventManager(actorId);
  const event = await prisma.attendanceEvent.findUnique({
    where: { id: eventId },
    include: { _count: { select: { attendances: true } } },
  });
  if (!event) throw new AttendanceEventError("Event not found.");
  if (event._count.attendances > 0) {
    throw new AttendanceEventError(
      `This event has ${event._count.attendances} attendance ${
        event._count.attendances === 1 ? "record" : "records"
      }. Remove them first if you really mean to delete it.`,
    );
  }
  await prisma.attendanceEvent.delete({ where: { id: eventId } });
  await recordAudit({
    actorPersonId: actorId,
    action: "recruitment.event_deleted",
    entityType: "AttendanceEvent",
    entityId: eventId,
    before: { kind: event.kind, title: event.title, startsAt: event.startsAt },
  });
}

/**
 * The TRAINING event for a cycle, created on first use from the cycle's
 * inPersonTrainingDate.
 *
 * This is what lets the existing Training roster keep working: its per-row
 * button now routes through event check-in, and the event it writes to has to
 * exist without anyone having created one by hand. Idempotent -- the first
 * TRAINING event for the cycle wins, so repeated calls return the same row and
 * never split one session's attendance across two events.
 */
export async function ensureTrainingEventForCycle(
  cycleId: string,
  actorId: string,
): Promise<AttendanceEvent> {
  const cycle = await prisma.recruitmentCycle.findUnique({
    where: { id: cycleId },
    select: { id: true, termId: true, title: true, inPersonTrainingDate: true, trainingLocation: true },
  });
  if (!cycle) throw new AttendanceEventError("Cycle not found.");

  const existing = await prisma.attendanceEvent.findFirst({
    where: { cycleId, kind: "TRAINING" },
    orderBy: { createdAt: "asc" },
  });
  if (existing) return existing;

  await requireEventManager(actorId);
  return prisma.attendanceEvent.create({
    data: {
      termId: cycle.termId,
      cycleId: cycle.id,
      kind: "TRAINING",
      title: `${cycle.title} training`,
      // No scheduled date is not a reason to refuse: attendance is being taken
      // right now, which is itself the fact worth recording. The cycle's date is
      // a noon-UTC calendar date, so it lands at midday rather than pretending
      // to a start time nobody entered.
      startsAt: cycle.inPersonTrainingDate ?? new Date(),
      location: cycle.trainingLocation,
    },
  });
}

export type EventListRow = AttendanceEvent & {
  attendeeCount: number;
  unlinkedCount: number;
  cycleTitle: string | null;
};

/** Events for a term (or a single cycle), soonest-first within past/future. */
export async function listEvents(opts: {
  termId?: string;
  cycleId?: string;
}): Promise<EventListRow[]> {
  const events = await prisma.attendanceEvent.findMany({
    where: {
      ...(opts.termId ? { termId: opts.termId } : {}),
      ...(opts.cycleId ? { cycleId: opts.cycleId } : {}),
    },
    orderBy: { startsAt: "desc" },
    include: {
      cycle: { select: { title: true } },
      _count: { select: { attendances: true } },
    },
  });

  // One grouped count for the unlinked total rather than N queries.
  const unlinked = await prisma.eventAttendance.groupBy({
    by: ["eventId"],
    where: { eventId: { in: events.map((e) => e.id) }, personId: null },
    _count: { _all: true },
  });
  const unlinkedByEvent = new Map(unlinked.map((u) => [u.eventId, u._count._all]));

  return events.map(({ cycle, _count, ...event }) => ({
    ...event,
    attendeeCount: _count.attendances,
    unlinkedCount: unlinkedByEvent.get(event.id) ?? 0,
    cycleTitle: cycle?.title ?? null,
  }));
}

export type AttendeeRow = {
  id: string;
  personId: string | null;
  name: string;
  email: string | null;
  method: EventAttendance["method"];
  checkedInAt: Date;
  recordedByName: string | null;
  note: string | null;
  /** Blockers as they stand NOW, not the check-in snapshot. */
  blockers: string[];
  nudgeCount: number;
};

export type EventDetail = {
  event: AttendanceEvent & { cycleTitle: string | null; cycleTrack: Track | null };
  attendees: AttendeeRow[];
  /** Walk-up rows whose email matches a Person, ready to link in one click. */
  linkSuggestions: { attendanceId: string; personId: string; personName: string }[];
};

export async function getEventDetail(eventId: string): Promise<EventDetail | null> {
  const event = await prisma.attendanceEvent.findUnique({
    where: { id: eventId },
    include: { cycle: { select: { title: true, track: true } } },
  });
  if (!event) return null;

  const rows = await prisma.eventAttendance.findMany({
    where: { eventId },
    orderBy: { checkedInAt: "asc" },
    include: {
      person: { select: { id: true, name: true, contactEmail: true } },
      recordedBy: { select: { name: true } },
    },
  });

  const linkedIds = rows.map((r) => r.personId).filter((id): id is string => id !== null);
  const blockers = await resolveAttendanceBlockers(linkedIds, event.termId);

  // Unlinked rows whose email already belongs to somebody: offer the match
  // rather than making a staffer search for it. Matching is on the lowercased
  // address, the same key linkAttendee and the nudge pass use.
  const unlinkedEmails = rows
    .filter((r) => r.personId === null && r.attendeeEmail)
    .map((r) => r.attendeeEmail as string);
  const matches = unlinkedEmails.length
    ? await prisma.person.findMany({
        where: { contactEmail: { in: unlinkedEmails, mode: "insensitive" } },
        select: { id: true, name: true, contactEmail: true },
      })
    : [];
  const matchByEmail = new Map(
    matches.map((m) => [(m.contactEmail ?? "").toLowerCase(), m]),
  );

  const linkSuggestions: EventDetail["linkSuggestions"] = [];
  for (const row of rows) {
    if (row.personId !== null || !row.attendeeEmail) continue;
    const match = matchByEmail.get(row.attendeeEmail);
    if (match) {
      linkSuggestions.push({ attendanceId: row.id, personId: match.id, personName: match.name });
    }
  }

  // `cycle` is destructured off rather than spread through: the two flattened
  // fields are what callers use, and leaving the relation object on a value that
  // reaches a page keeps handing serialization a nested shape nobody reads.
  const { cycle, ...eventFields } = event;
  return {
    event: {
      ...eventFields,
      cycleTitle: cycle?.title ?? null,
      cycleTrack: cycle?.track ?? null,
    },
    attendees: rows.map((r) => ({
      id: r.id,
      personId: r.personId,
      name: r.person?.name ?? r.attendeeName ?? "Unnamed attendee",
      email: r.person?.contactEmail ?? r.attendeeEmail,
      method: r.method,
      checkedInAt: r.checkedInAt,
      recordedByName: r.recordedBy?.name ?? null,
      note: r.note,
      blockers: r.personId ? (blockers.get(r.personId)?.items ?? []) : [],
      nudgeCount: r.nudgeCount,
    })),
    linkSuggestions,
  };
}

// ---------------------------------------------------------------------------
// Check-in
// ---------------------------------------------------------------------------

export type CheckInCandidate = {
  personId: string;
  name: string;
  email: string | null;
  /** Department codes of ACTIVE memberships this term; empty for a non-member. */
  departmentCodes: string[];
  /** True when the person holds no ACTIVE membership in the event's term. */
  offRoster: boolean;
  /** Already checked in to this event. */
  checkedIn: boolean;
};

/**
 * Everyone the viewer may check in to this event, with enough context for the
 * door: department, whether they are on the roster at all, and whether they have
 * already been checked in.
 *
 * Deliberately NOT restricted to the term roster, which is the whole point of
 * the feature: an accepted applicant who has not onboarded, an alum returning to
 * help, and a member of another department are all people who legitimately turn
 * up. A department-scoped viewer still only sees their own departments' members.
 *
 * Returned whole and filtered in the browser: a kiosk is used by someone typing
 * fast at a door, and a round trip per keystroke is the wrong trade against a
 * list of this size (all Person rows, name and email only).
 */
export async function listCheckInCandidates(
  eventId: string,
  actorId: string,
): Promise<CheckInCandidate[]> {
  const event = await prisma.attendanceEvent.findUnique({
    where: { id: eventId },
    select: { id: true, termId: true },
  });
  if (!event) throw new AttendanceEventError("Event not found.");

  const authority = await resolveAttendanceAuthority(actorId);
  if (!authority.all && authority.departmentCodes.length === 0) {
    throw new RecruitmentAuthError("You can't record attendance.");
  }

  const memberships = await prisma.termMembership.findMany({
    where: { termId: event.termId, status: "ACTIVE" },
    select: { personId: true, department: { select: { code: true } } },
  });
  const deptsByPerson = new Map<string, string[]>();
  for (const m of memberships) {
    const list = deptsByPerson.get(m.personId) ?? [];
    list.push(m.department.code);
    deptsByPerson.set(m.personId, list);
  }

  const people = await prisma.person.findMany({
    where: authority.all
      ? // Current people only. An offboarded alum who turns up to help at an info
        // session is not lost: typing their address into the walk-up form matches
        // their existing Person (see recordEventCheckIn) and links the row, so
        // they never become an orphan -- they just do not clutter the door list.
        { status: "ACTIVE" }
      : // A scoped director sees only their own departments' active members.
        {
          memberships: {
            some: {
              termId: event.termId,
              status: "ACTIVE",
              department: { code: { in: authority.departmentCodes } },
            },
          },
        },
    select: { id: true, name: true, contactEmail: true },
    orderBy: { name: "asc" },
  });

  const checkedIn = new Set(
    (
      await prisma.eventAttendance.findMany({
        where: { eventId, personId: { not: null } },
        select: { personId: true },
      })
    ).map((r) => r.personId as string),
  );

  return people.map((p) => {
    const departmentCodes = deptsByPerson.get(p.id) ?? [];
    return {
      personId: p.id,
      name: p.name,
      email: p.contactEmail,
      departmentCodes,
      offRoster: departmentCodes.length === 0,
      checkedIn: checkedIn.has(p.id),
    };
  });
}

export type CheckInTarget =
  | { kind: "person"; personId: string }
  | { kind: "walkUp"; name: string; email: string };

/**
 * What the kiosk gets back. A refusal is a value, not a throw, because the door
 * screen has to show it without losing the queue it is working through; the
 * server action converts the two expected service errors into the failure arm.
 */
export type CheckInResult = ({ ok: true } & CheckInOutcome) | { ok: false; message: string };

export type CheckInOutcome = {
  attendanceId: string;
  name: string;
  /** True when the row already existed: the caller should not double-report it. */
  alreadyCheckedIn: boolean;
  /** Whether this check-in completed (or had already completed) training. */
  trainingCredited: boolean;
  blockers: string[];
  /** Whether a nudge email was queued for this check-in. */
  nudgeQueued: boolean;
};

/** Authorize one check-in target against the viewer's authority. */
async function authorizeTarget(
  event: { termId: string },
  target: CheckInTarget,
  authority: AttendanceAuthority,
): Promise<void> {
  if (authority.all) return;
  if (authority.departmentCodes.length === 0) {
    throw new RecruitmentAuthError("You can't record attendance.");
  }
  if (target.kind === "walkUp") {
    throw new RecruitmentAuthError(
      "Adding someone who is not in the hub needs clinic-wide attendance permission.",
    );
  }
  const inScope = await prisma.termMembership.findFirst({
    where: {
      personId: target.personId,
      termId: event.termId,
      status: "ACTIVE",
      department: { code: { in: authority.departmentCodes } },
    },
    select: { id: true },
  });
  if (!inScope) {
    throw new RecruitmentAuthError("You can't record attendance for that person.");
  }
}

/**
 * Record one check-in.
 *
 * Idempotent by construction: the row is upserted on whichever unique key
 * applies, so the second call returns the first row with alreadyCheckedIn set
 * and sends no second email. The training completion and the nudge both hang off
 * a FIRST insert only.
 */
export async function recordEventCheckIn(
  eventId: string,
  target: CheckInTarget,
  actorId: string,
): Promise<CheckInOutcome> {
  const event = await prisma.attendanceEvent.findUnique({
    where: { id: eventId },
    include: { cycle: { select: { id: true, track: true } } },
  });
  if (!event) throw new AttendanceEventError("Event not found.");

  const authority = await resolveAttendanceAuthority(actorId);
  await authorizeTarget(event, target, authority);

  let personId: string | null = null;
  let name: string;
  let email: string | null = null;

  if (target.kind === "person") {
    const person = await prisma.person.findUnique({
      where: { id: target.personId },
      select: { id: true, name: true },
    });
    if (!person) throw new AttendanceEventError("Person not found.");
    personId = person.id;
    name = person.name;
  } else {
    name = target.name.trim();
    email = target.email.trim().toLowerCase();
    if (name.length === 0) throw new AttendanceEventError("Give the attendee's name.");
    // An email is required for a walk-up and not for a member, because it is the
    // ONLY thing that can later connect this row to a person -- and the only way
    // to reach them with the nudge. A nameless-but-emailed row is recoverable; an
    // email-less one is a tally mark.
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      throw new AttendanceEventError("Give the attendee a valid email address.");
    }
    // Someone typed in as a walk-up who actually has an account should become a
    // linked row, not an orphan needing reconciliation later.
    const match = await prisma.person.findFirst({
      where: { contactEmail: { equals: email, mode: "insensitive" } },
      select: { id: true, name: true },
    });
    if (match) {
      personId = match.id;
      name = match.name;
      email = null;
    }
  }

  const findExisting = () =>
    prisma.eventAttendance.findFirst({
      where: personId ? { eventId, personId } : { eventId, attendeeEmail: email },
      select: { id: true },
    });

  const existing = await findExisting();

  if (existing) {
    const blockers = personId
      ? (await resolveAttendanceBlockers([personId], event.termId)).get(personId)
      : undefined;
    return {
      attendanceId: existing.id,
      name,
      alreadyCheckedIn: true,
      trainingCredited: event.kind === "TRAINING" && personId !== null,
      blockers: blockers?.items ?? [],
      nudgeQueued: false,
    };
  }

  // A walk-up has no Person, so no clearance can be looked up: WALK_UP_BLOCKERS
  // is the honest answer (they are on no roster at all).
  const blockers: AttendanceBlockers = personId
    ? ((await resolveAttendanceBlockers([personId], event.termId)).get(personId) ?? NO_BLOCKERS)
    : WALK_UP_BLOCKERS;

  let attendance: EventAttendance;
  try {
    attendance = await prisma.$transaction(async (tx) => {
      const row = await tx.eventAttendance.create({
        data: {
          eventId,
          personId,
          attendeeName: personId ? null : name,
          attendeeEmail: personId ? null : email,
          method: personId ? "STAFF" : "WALK_UP",
          recordedById: actorId,
          blockersAtCheckIn: blockers.keys,
          // Nothing outstanding means there is nothing to chase, so the row starts
          // resolved rather than joining the nudge stream and being resolved on the
          // first pass.
          resolvedAt: blockers.keys.length === 0 ? new Date() : null,
        },
      });
      await creditTrainingIfApplicable(tx, event, personId, actorId);
      return row;
    });
  } catch (err) {
    // Two staffers working the same door tapped the same person at the same
    // moment: both read no existing row, and the unique index let exactly one
    // insert win. The loser is not an error -- the attendance IS recorded -- so
    // report it as the duplicate it is rather than failing at the door, which is
    // the whole point of having the constraint. The winner's transaction did the
    // training credit and will send the one nudge.
    if (isUniqueConstraintError(err)) {
      const raced = await findExisting();
      if (raced) {
        return {
          attendanceId: raced.id,
          name,
          alreadyCheckedIn: true,
          trainingCredited: event.kind === "TRAINING" && personId !== null,
          blockers: blockers.items,
          nudgeQueued: false,
        };
      }
    }
    throw err;
  }

  await recordAudit({
    actorPersonId: actorId,
    action: "recruitment.event_check_in",
    entityType: "EventAttendance",
    entityId: attendance.id,
    after: { eventId, personId, attendeeEmail: attendance.attendeeEmail, method: attendance.method },
  });

  // The email is deliberately OUTSIDE the transaction and its failure is
  // swallowed: a queued nudge is worth much less than the attendance record, and
  // an SMTP-shaped problem must never cost a check-in at a door with a queue
  // behind it. The row keeps nudgeCount 0, so the recurring pass picks it up.
  let nudgeQueued = false;
  if (blockers.keys.length > 0) {
    try {
      nudgeQueued = await sendAttendanceNudge(attendance.id, actorId);
    } catch (err) {
      log.error("[attendance] nudge email failed", {
        attendanceId: attendance.id,
        ...errorAttrs(err),
      });
    }
  }

  return {
    attendanceId: attendance.id,
    name,
    alreadyCheckedIn: false,
    trainingCredited: event.kind === "TRAINING" && personId !== null,
    blockers: blockers.items,
    nudgeQueued,
  };
}

/**
 * The training bridge: a TRAINING event's check-in completes training.
 *
 * No membership check, unlike the recordAttendance it replaces. Training is
 * keyed (personId, termId, track), so writing it for someone who has not
 * onboarded yet is not a lie about their roster status -- it is the attendance
 * fact, waiting for the roster row promotion will create. Their /get-started
 * checklist then shows training complete the moment they have one, instead of
 * asking them to sit through a session they already attended.
 */
async function creditTrainingIfApplicable(
  tx: Prisma.TransactionClient,
  event: { kind: AttendanceEventKind; termId: string; cycle: { id: string; track: Track } | null },
  personId: string | null,
  /** Null on the system path (auto-link at promotion), where there is no actor. */
  actorId: string | null,
): Promise<boolean> {
  if (event.kind !== "TRAINING" || personId === null) return false;
  // A TRAINING event always has a cycle at creation, but the relation is SetNull:
  // a deleted cycle leaves the event standing with no track to credit. Record the
  // attendance, credit nothing.
  if (!event.cycle) return false;
  await completeTraining(tx, {
    personId,
    termId: event.termId,
    cycleId: event.cycle.id,
    track: event.cycle.track,
    via: "ATTENDANCE",
    actorId: actorId ?? undefined,
  });
  return true;
}

/**
 * Undo a check-in.
 *
 * Reverses the training completion only when no OTHER training attendance for
 * the same person, term and track survives, and only when the completion is
 * actually attributable to attendance: a member who also passed the quiz keeps
 * their completion, because it was never this row's to give.
 */
export async function removeEventCheckIn(attendanceId: string, actorId: string): Promise<void> {
  const row = await prisma.eventAttendance.findUnique({
    where: { id: attendanceId },
    include: {
      event: { include: { cycle: { select: { id: true, track: true } } } },
    },
  });
  if (!row) throw new AttendanceEventError("Attendance record not found.");

  const authority = await resolveAttendanceAuthority(actorId);
  if (!authority.all) {
    if (row.personId === null) {
      // Removing an unlinked row is a clinic-wide act for the same reason
      // creating one is: there is no department to scope the decision against.
      throw new RecruitmentAuthError(
        "Removing an attendee who is not in the hub needs clinic-wide attendance permission.",
      );
    }
    await authorizeTarget(row.event, { kind: "person", personId: row.personId }, authority);
  }

  await prisma.$transaction(async (tx) => {
    await tx.eventAttendance.delete({ where: { id: attendanceId } });

    const { event, personId } = row;
    if (event.kind !== "TRAINING" || personId === null || !event.cycle) return;

    const others = await tx.eventAttendance.count({
      where: {
        personId,
        event: { kind: "TRAINING", termId: event.termId, cycle: { track: event.cycle.track } },
      },
    });
    if (others > 0) return;

    await tx.training.updateMany({
      where: {
        personId,
        termId: event.termId,
        track: event.cycle.track,
        completedVia: "ATTENDANCE",
      },
      data: {
        status: "PENDING",
        completedVia: null,
        completedAt: null,
        attendanceRecordedById: null,
        attendanceRecordedAt: null,
      },
    });
  });

  await recordAudit({
    actorPersonId: actorId,
    action: "recruitment.event_check_in_removed",
    entityType: "EventAttendance",
    entityId: attendanceId,
    before: {
      eventId: row.eventId,
      personId: row.personId,
      attendeeEmail: row.attendeeEmail,
      checkedInAt: row.checkedInAt,
    },
  });
}

/**
 * Attach an unlinked walk-up row to a person, backfilling whatever the link
 * implies: a TRAINING event's completion, and the nudge stream's knowledge of
 * what is actually outstanding for them.
 *
 * Merges rather than duplicates when the person was ALSO checked in directly:
 * the linked row is the one attendance the event has for them, so the walk-up
 * row is dropped and the earlier checkedInAt wins (they arrived once, and the
 * earlier of the two timestamps is when).
 */
export async function linkAttendee(
  attendanceId: string,
  personId: string,
  actorId: string,
): Promise<void> {
  const authority = await resolveAttendanceAuthority(actorId);
  if (!authority.all) {
    throw new RecruitmentAuthError("Linking an attendee needs clinic-wide attendance permission.");
  }

  const row = await prisma.eventAttendance.findUnique({
    where: { id: attendanceId },
    include: { event: { include: { cycle: { select: { id: true, track: true } } } } },
  });
  if (!row) throw new AttendanceEventError("Attendance record not found.");
  if (row.personId) throw new AttendanceEventError("That attendance is already linked to a person.");

  const person = await prisma.person.findUnique({ where: { id: personId }, select: { id: true } });
  if (!person) throw new AttendanceEventError("Person not found.");

  const blockers = await resolveAttendanceBlockers([personId], row.event.termId);
  const keys = blockers.get(personId)?.keys ?? [];

  await prisma.$transaction(async (tx) => {
    const duplicate = await tx.eventAttendance.findFirst({
      where: { eventId: row.eventId, personId },
      select: { id: true, checkedInAt: true },
    });
    if (duplicate) {
      if (row.checkedInAt < duplicate.checkedInAt) {
        await tx.eventAttendance.update({
          where: { id: duplicate.id },
          data: { checkedInAt: row.checkedInAt },
        });
      }
      await tx.eventAttendance.delete({ where: { id: attendanceId } });
    } else {
      await tx.eventAttendance.update({
        where: { id: attendanceId },
        data: {
          personId,
          attendeeName: null,
          attendeeEmail: null,
          blockersAtCheckIn: keys,
          resolvedAt: keys.length === 0 ? new Date() : null,
        },
      });
    }
    await creditTrainingIfApplicable(tx, row.event, personId, actorId);
  });

  await recordAudit({
    actorPersonId: actorId,
    action: "recruitment.event_attendee_linked",
    entityType: "EventAttendance",
    entityId: attendanceId,
    before: { attendeeEmail: row.attendeeEmail, attendeeName: row.attendeeName },
    after: { personId },
  });
}

/**
 * Sweep every unlinked attendance row whose email now belongs to a Person and
 * link it. Runs from the nudge cron, which is what catches the people the
 * promotion hook cannot: someone whose Person already existed under a different
 * flow, or a row written after their promotion had already happened.
 *
 * Returns how many rows it linked. Intentionally quiet about the rest: an
 * unlinked row with no matching person is the normal state of a prospective
 * applicant who has not applied yet.
 */
export async function relinkUnlinkedAttendance(): Promise<number> {
  const rows = await prisma.eventAttendance.findMany({
    where: { personId: null, attendeeEmail: { not: null } },
    select: { attendeeEmail: true },
  });
  if (rows.length === 0) return 0;

  const emails = Array.from(new Set(rows.map((r) => r.attendeeEmail as string)));
  const people = await prisma.person.findMany({
    where: { contactEmail: { in: emails, mode: "insensitive" } },
    select: { id: true, contactEmail: true },
  });

  let linked = 0;
  for (const person of people) {
    linked += await linkAttendanceByEmail(person.id, person.contactEmail);
  }
  return linked;
}

/**
 * Link every unlinked attendance row whose email matches this person, and credit
 * whatever those links imply. Called from promotion, where a Person is created
 * from an onboarding contract -- the exact moment an info-session or training
 * walk-up stops being an orphan.
 *
 * Runs as the system rather than an actor (no permission check): it is triggered
 * by the attendee's own onboarding, not by a staffer, and it grants nothing that
 * was not already recorded at a door.
 */
export async function linkAttendanceByEmail(
  personId: string,
  email: string | null,
): Promise<number> {
  if (!email) return 0;
  const key = email.trim().toLowerCase();
  if (key.length === 0) return 0;

  const rows = await prisma.eventAttendance.findMany({
    where: { personId: null, attendeeEmail: key },
    include: { event: { include: { cycle: { select: { id: true, track: true } } } } },
  });
  if (rows.length === 0) return 0;

  let linked = 0;
  for (const row of rows) {
    try {
      await prisma.$transaction(async (tx) => {
        const duplicate = await tx.eventAttendance.findFirst({
          where: { eventId: row.eventId, personId },
          select: { id: true, checkedInAt: true },
        });
        if (duplicate) {
          if (row.checkedInAt < duplicate.checkedInAt) {
            await tx.eventAttendance.update({
              where: { id: duplicate.id },
              data: { checkedInAt: row.checkedInAt },
            });
          }
          await tx.eventAttendance.delete({ where: { id: row.id } });
        } else {
          await tx.eventAttendance.update({
            where: { id: row.id },
            data: { personId, attendeeName: null, attendeeEmail: null },
          });
        }
        await creditTrainingIfApplicable(tx, row.event, personId, null);
      });
      linked++;
    } catch (err) {
      // One unlinkable row must not fail the promotion that triggered this.
      log.error("[attendance] auto-link failed", {
        attendanceId: row.id,
        personId,
        ...errorAttrs(err),
      });
    }
  }
  return linked;
}
