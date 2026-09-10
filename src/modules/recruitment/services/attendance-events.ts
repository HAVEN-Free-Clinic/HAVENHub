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

import type { AttendanceEvent, AttendanceEventKind, EventAttendance, Track } from "@prisma/client";
import { prisma, isUniqueConstraintError, type TransactionClient } from "@/platform/db";
import { can } from "@/platform/rbac/engine";
import { recordAudit } from "@/platform/audit";
import { log, errorAttrs } from "@/platform/logging";
import { RecruitmentAuthError, reviewScope } from "./review";
import { completeTraining } from "./training";
import { resolveAttendanceBlockers, isAcceptedApplicantEmail, ACCEPTED_APPLICANT_BLOCKERS, WALK_UP_BLOCKERS, NO_BLOCKERS, type AttendanceBlockers } from "@/platform/compliance/attendance-blockers";
import type { OutstandingItemKey } from "@/platform/compliance/outstanding-items";
import { sendAttendanceNudge } from "@/platform/email/attendance-nudges";

export class AttendanceEventError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AttendanceEventError";
  }
}

/**
 * Not a failure: a question the door has to ask before it writes.
 *
 * Its own class rather than an AttendanceEventError with a special message,
 * because the two want opposite treatment on screen -- one is red and means
 * something went wrong, the other is a prompt with two buttons -- and matching on
 * message text to tell them apart is how that stops working the first time
 * somebody rewords it.
 */
export class CheckInConfirmationRequired extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CheckInConfirmationRequired";
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
  termName: string;
};

/**
 * Events for a set of terms (or a single cycle), newest-first.
 *
 * `termIds` is a LIST rather than the single id this took, because an event's
 * term comes from its cycle and a recruitment cycle recruits for the term
 * AFTER the one running: every event the clinic had was attached to the term in
 * preparation while the events page asked only about the live one, so the page
 * was empty from the day it shipped. Callers pass every term they mean.
 *
 * An empty or absent list means no term filter at all.
 */
export async function listEvents(opts: {
  termIds?: string[];
  cycleId?: string;
}): Promise<EventListRow[]> {
  const events = await prisma.attendanceEvent.findMany({
    where: {
      ...(opts.termIds && opts.termIds.length > 0 ? { termId: { in: opts.termIds } } : {}),
      ...(opts.cycleId ? { cycleId: opts.cycleId } : {}),
    },
    orderBy: { startsAt: "desc" },
    include: {
      cycle: { select: { title: true } },
      term: { select: { name: true } },
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

  return events.map(({ cycle, term, _count, ...event }) => ({
    ...event,
    attendeeCount: _count.attendances,
    unlinkedCount: unlinkedByEvent.get(event.id) ?? 0,
    cycleTitle: cycle?.title ?? null,
    termName: term.name,
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
  /**
   * Which of the two shapes this row is.
   *
   * `person` has a Person row and checks in by id. `applicant` does NOT: they
   * were accepted into the event's cycle but have not submitted the onboarding
   * contract that promotion turns into a Person, so the only handle on them is
   * the email they applied with.
   */
  kind: "person" | "applicant";
  /** Person id, or acceptance id for an `applicant`. Unique within the list. */
  id: string;
  name: string;
  email: string | null;
  /** From Person.netId, or Applicant.netId. Lowercased; the exact-match key. */
  netId: string | null;
  /** Department codes of ACTIVE memberships this term; the accepted department for an applicant. */
  departmentCodes: string[];
  /** True when nobody holds an ACTIVE membership in the event's term for this row. */
  offRoster: boolean;
  /** On this cycle's accepted list. Always true for an `applicant`. */
  accepted: boolean;
  /**
   * One of the people this session is being run for, rather than somebody who
   * turned up to it.
   *
   * False for, most often, a DIRECTOR at a volunteer training: on the term
   * roster, legitimately in the room, frequently helping to run the session, and
   * not one of the volunteers whose attendance it exists to record. The door
   * lists them under their own heading so an operator working a queue is not
   * reading one undifferentiated list of everybody in the clinic.
   *
   * Always true when the event has no cycle: with no track there is no cohort to
   * be outside of, and the door shows a single pile.
   */
  expected: boolean;
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
 * TWO sources, because a Person is not created until promotion.
 *
 * The roster half is Person rows. The other half is the event cycle's
 * ACCEPTANCES whose contract has not promoted yet -- people the clinic has
 * decided are volunteers, who own a seat at this training, and who do not exist
 * as a Person to search for. Before they were added here the only way to record
 * them was to hand-type a name and address into the walk-up form, at a door,
 * from memory, for a person the hub could already name.
 *
 * They are deduped against the Person half on lowercased email, which is what
 * keeps a returning member (Person from a past term, plus a fresh acceptance for
 * this one) from appearing twice under two different check-in gestures.
 *
 * Returned whole and filtered in the browser: a kiosk is used by someone typing
 * fast at a door, and a round trip per keystroke is the wrong trade against a
 * list of this size (name, email and netId only).
 */
export async function listCheckInCandidates(
  eventId: string,
  actorId: string,
): Promise<CheckInCandidate[]> {
  const event = await prisma.attendanceEvent.findUnique({
    where: { id: eventId },
    // The track comes along because it decides which candidates this session is
    // FOR: a volunteer training and a director training draw different cohorts
    // from the same roster.
    select: { id: true, termId: true, cycleId: true, cycle: { select: { track: true } } },
  });
  if (!event) throw new AttendanceEventError("Event not found.");

  const authority = await resolveAttendanceAuthority(actorId);
  if (!authority.all && authority.departmentCodes.length === 0) {
    throw new RecruitmentAuthError("You can't record attendance.");
  }

  const memberships = await prisma.termMembership.findMany({
    where: { termId: event.termId, status: "ACTIVE" },
    select: { personId: true, kind: true, department: { select: { code: true } } },
  });
  const deptsByPerson = new Map<string, string[]>();
  // Membership KINDS, not just departments: a training session is run for one
  // track, and whether somebody's membership matches it is what separates the
  // people the session is FOR from the people who merely turned up to it.
  const kindsByPerson = new Map<string, Set<Track>>();
  for (const m of memberships) {
    const list = deptsByPerson.get(m.personId) ?? [];
    list.push(m.department.code);
    deptsByPerson.set(m.personId, list);
    const kinds = kindsByPerson.get(m.personId) ?? new Set<Track>();
    kinds.add(m.kind);
    kindsByPerson.set(m.personId, kinds);
  }

  const [people, acceptances, attendance] = await Promise.all([
    prisma.person.findMany({
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
      select: { id: true, name: true, netId: true, contactEmail: true },
      orderBy: { name: "asc" },
    }),
    // The whole accepted list, promoted or not. The promoted ones never become
    // applicant rows -- they are already in the roster half above -- but they are
    // still needed here to mark those Person rows `accepted`, which is what tells
    // the door that a member standing in front of it belongs at this training.
    //
    // Skipped entirely for a scoped director: an unlinked row is a clinic-wide
    // assertion with no department to check it against, which is why they may not
    // add walk-ups either (see authorizeTarget). Filtered in the query rather
    // than the projection so their payload never carries a list they cannot act on.
    event.cycleId && authority.all
      ? prisma.acceptance.findMany({
          where: { application: { cycleId: event.cycleId } },
          select: {
            id: true,
            departmentCode: true,
            // Promotion is what creates the Person, so this is the authoritative
            // "already on the roster" link. Email is only the fallback, for the
            // rows that have no link at all.
            contract: { select: { promotedPersonId: true } },
            application: {
              select: {
                applicant: {
                  select: {
                    firstName: true,
                    lastName: true,
                    email: true,
                    emailLower: true,
                    netId: true,
                  },
                },
              },
            },
          },
        })
      : Promise.resolve([]),
    prisma.eventAttendance.findMany({
      where: { eventId },
      select: { personId: true, attendeeEmail: true },
    }),
  ]);

  const checkedInPersonIds = new Set(attendance.flatMap((r) => (r.personId ? [r.personId] : [])));
  const checkedInEmails = new Set(
    attendance.flatMap((r) => (r.attendeeEmail ? [r.attendeeEmail.toLowerCase()] : [])),
  );
  const acceptedEmails = new Set(acceptances.map((a) => a.application.applicant.emailLower));

  /**
   * The track this session is being run for, or null for an event that is not
   * for one particular cohort (an info session, or a training with no cycle).
   * With no track, nobody can be "not on this list" and the door shows one pile.
   */
  const sessionTrack: Track | null = event.cycle?.track ?? null;

  const personRows: CheckInCandidate[] = people.map((p) => {
    const departmentCodes = deptsByPerson.get(p.id) ?? [];
    const email = p.contactEmail?.toLowerCase() ?? null;
    const accepted = email !== null && acceptedEmails.has(email);
    return {
      kind: "person" as const,
      id: p.id,
      name: p.name,
      email: p.contactEmail,
      netId: p.netId?.toLowerCase() ?? null,
      departmentCodes,
      offRoster: departmentCodes.length === 0,
      accepted,
      // Expected here if the clinic accepted them into this cycle, or if they
      // already hold a membership of the track this session trains. A DIRECTOR at
      // a volunteer training is neither: still checkable in (they do turn up, and
      // recording that is the point), just not one of the people the session is
      // for -- which is the whole reason the door piles them separately.
      expected: sessionTrack === null || accepted || (kindsByPerson.get(p.id)?.has(sessionTrack) ?? false),
      checkedIn: checkedInPersonIds.has(p.id),
    };
  });

  // Every address the roster half already answers for, so an acceptance whose
  // applicant also has a Person -- a returning member, or anyone whose Person was
  // created some other way -- does not appear a second time under a gesture that
  // would write an unlinked row for someone the hub can link directly.
  const personEmails = new Set(
    people.flatMap((p) => (p.contactEmail ? [p.contactEmail.toLowerCase()] : [])),
  );

  // Keyed on email, not acceptance id: an application accepted by two departments
  // is TWO Acceptance rows for one human (the state findAcceptanceConflicts
  // exists to flag), and the door must not offer the same person twice under two
  // buttons that write the same row. The departments merge onto one entry, which
  // is also the more useful thing to read at a door -- the conflict is visible
  // rather than hidden behind a duplicate.
  const byEmail = new Map<string, CheckInCandidate>();
  for (const a of acceptances) {
    if (a.contract?.promotedPersonId) continue;
    const applicant = a.application.applicant;
    if (personEmails.has(applicant.emailLower)) continue;
    const existing = byEmail.get(applicant.emailLower);
    if (existing) {
      if (!existing.departmentCodes.includes(a.departmentCode)) {
        existing.departmentCodes.push(a.departmentCode);
      }
      continue;
    }
    byEmail.set(applicant.emailLower, {
      kind: "applicant",
      id: a.id,
      name: `${applicant.firstName} ${applicant.lastName}`.trim(),
      email: applicant.email,
      netId: applicant.netId?.toLowerCase() ?? null,
      departmentCodes: [a.departmentCode],
      offRoster: true,
      accepted: true,
      // Being accepted into this cycle is exactly what "expected" means.
      expected: true,
      checkedIn: checkedInEmails.has(applicant.emailLower),
    });
  }
  const applicantRows = [...byEmail.values()];

  return [...personRows, ...applicantRows].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * A cheap stamp that moves whenever this event's attendance changes.
 *
 * Row count plus the latest `updatedAt`, both covered by the `eventId` index, so
 * an idle door costs one small aggregate per tick and sends nothing. Modelled on
 * the schedule builder's boardRevision, which the change stream this feeds is
 * otherwise a copy of.
 *
 * Count AND timestamp, because neither alone is enough: a check-in followed by an
 * undo returns the count to where it was, and two rows written inside the same
 * millisecond share a timestamp.
 */
export async function attendanceRevision(eventId: string): Promise<string> {
  const agg = await prisma.eventAttendance.aggregate({
    where: { eventId },
    _count: { _all: true },
    _max: { updatedAt: true },
  });
  return `${agg._count._all}:${agg._max.updatedAt?.getTime() ?? 0}`;
}

/**
 * Everything the door has to repaint when somebody ELSE checks a person in.
 *
 * A full snapshot rather than a delta, for the reason the builder's stream gives:
 * the payload is small and a snapshot cannot desynchronize the way an applied
 * sequence of deltas does when one is missed across a reconnect.
 *
 * Identity comes back in both currencies because the door's two candidate shapes
 * are matched differently -- a member by personId, an accepted applicant by the
 * lowercased email their unlinked row is keyed on.
 */
export type DoorSnapshot = {
  revision: string;
  /** Names in check-in order, newest last: the list and its count. */
  names: string[];
  /** Person ids with a linked row on this event. */
  personIds: string[];
  /** Lowercased emails of unlinked rows on this event. */
  emails: string[];
};

export async function doorSnapshot(eventId: string): Promise<DoorSnapshot> {
  const [revision, rows] = await Promise.all([
    attendanceRevision(eventId),
    prisma.eventAttendance.findMany({
      where: { eventId },
      orderBy: { checkedInAt: "asc" },
      select: {
        personId: true,
        attendeeName: true,
        attendeeEmail: true,
        person: { select: { name: true } },
      },
    }),
  ]);
  return {
    revision,
    names: rows.map((r) => r.person?.name ?? r.attendeeName ?? "Unknown"),
    personIds: rows.flatMap((r) => (r.personId ? [r.personId] : [])),
    emails: rows.flatMap((r) => (r.attendeeEmail ? [r.attendeeEmail.toLowerCase()] : [])),
  };
}

/**
 * How many people the cycle accepted, as the denominator of "38 of 61 accepted".
 *
 * Counted by distinct applicant, not by Acceptance row: an application accepted
 * by two departments is two rows and one human walking through one door, and a
 * door that says "38 of 63" because two people were double-accepted is a target
 * nobody can ever hit.
 *
 * Null for an event with no cycle, where there is no roll to be counted against
 * and the screen shows a bare tally instead of a fraction.
 */
export async function countAcceptedForCycle(cycleId: string | null): Promise<number | null> {
  if (!cycleId) return null;
  const rows = await prisma.acceptance.findMany({
    where: { application: { cycleId } },
    select: { application: { select: { applicantId: true } } },
  });
  return new Set(rows.map((r) => r.application.applicantId)).size;
}

export type CheckInTarget =
  | { kind: "person"; personId: string }
  /**
   * Someone accepted into the event's cycle who has no Person yet. The server
   * reads their name and address off the acceptance rather than trusting the
   * browser for either, then records exactly the walk-up row a hand-typed
   * check-in would have produced -- which is what lets promotion link it later.
   */
  | { kind: "applicant"; acceptanceId: string }
  | {
      kind: "walkUp";
      name: string;
      email: string;
      /**
       * Set once the operator has answered the "not on the accepted list"
       * question. Absent, an address the cycle has never accepted comes back as
       * `requiresConfirmation` instead of being written.
       */
      confirmed?: boolean;
    };

/**
 * What the kiosk gets back. A refusal is a value, not a throw, because the door
 * screen has to show it without losing the queue it is working through; the
 * server action converts the two expected service errors into the failure arm.
 *
 * `requiresConfirmation` is a third state wearing the refusal's clothes: nothing
 * was written, but nothing is wrong either, and the door renders it as a question
 * rather than an error.
 */
export type CheckInResult =
  | ({ ok: true } & CheckInOutcome)
  | { ok: false; message: string; requiresConfirmation?: boolean };

export type CheckInOutcome = {
  attendanceId: string;
  name: string;
  /** True when the row already existed: the caller should not double-report it. */
  alreadyCheckedIn: boolean;
  /** Whether this check-in completed (or had already completed) training. */
  trainingCredited: boolean;
  /** Outstanding items as member-facing sentences, the same ones the email carries. */
  blockers: string[];
  /**
   * The same items as keys, for a door screen that renders chips rather than
   * sentences. Sent alongside rather than instead of `blockers` so the screen and
   * the email are demonstrably the same list.
   */
  blockerKeys: OutstandingItemKey[];
  /**
   * The address the hub holds for this attendee, so the door can read it back
   * and have the wrong one corrected on the spot -- the one moment in the whole
   * flow where the person it belongs to is standing right there.
   */
  contactEmail: string | null;
  /**
   * An unlinked attendee the event's cycle never accepted -- someone who owes an
   * application, not just a contract. The `contract` blocker key cannot express
   * the difference (both cases raise it), and it is exactly the difference the
   * operator was asked about a moment ago, so it travels as its own flag.
   */
  notOnAcceptedList: boolean;
  /** Whether a nudge email was queued for this check-in. */
  nudgeQueued: boolean;
};

/**
 * Will this check-in complete training as a side effect?
 *
 * The same three conditions creditTrainingIfApplicable applies, named once so
 * the blocker list and the write cannot disagree about whether training just
 * happened.
 */
function creditsTraining(
  event: { kind: AttendanceEventKind; cycle: { track: Track } | null },
  personId: string | null,
): boolean {
  return event.kind === "TRAINING" && personId !== null && event.cycle !== null;
}

/** The same blockers with this track's training task removed. */
function withoutTrainingKey(blockers: AttendanceBlockers, track: Track): AttendanceBlockers {
  // Which of the two keys clearance raises depends on the track, exactly as
  // modules/onboarding/services/clearance.ts chooses it.
  const key: OutstandingItemKey = track === "DIRECTOR" ? "directorTraining" : "training";
  const at = blockers.keys.indexOf(key);
  if (at === -1) return blockers;
  // Dropped by INDEX, not rebuilt from the surviving keys. outstandingItems emits
  // one sentence per key in order, and some of those sentences carry detail the
  // keys alone cannot reproduce -- the EHS row is appended with the specific
  // outstanding course names, which a rebuild without the ehsMissing lookup would
  // silently throw away.
  return {
    keys: blockers.keys.filter((_, i) => i !== at),
    items: blockers.items.filter((_, i) => i !== at),
  };
}

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
  if (target.kind === "walkUp" || target.kind === "applicant") {
    // An applicant check-in writes an unlinked row exactly like a walk-up does,
    // so it carries the walk-up rule: a row with no Person has no department for
    // a scoped director's authority to be checked against.
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
  let contactEmail: string | null = null;
  /** Whether an unlinked attendee's address is on the cycle's accepted list. */
  let onAcceptedList = false;

  if (target.kind === "person") {
    const person = await prisma.person.findUnique({
      where: { id: target.personId },
      select: { id: true, name: true, contactEmail: true },
    });
    if (!person) throw new AttendanceEventError("Person not found.");
    personId = person.id;
    name = person.name;
    contactEmail = person.contactEmail;
  } else {
    // Both remaining arms end up as the same unlinked row; they differ only in
    // where the name and address come from. An applicant's are read from their
    // acceptance, so the door never asks an operator to retype what the hub
    // already knows -- and never lets a browser assert an identity for a row
    // that gets linked to a real person later.
    let requested: { name: string; email: string };
    if (target.kind === "applicant") {
      const acceptance = await prisma.acceptance.findUnique({
        where: { id: target.acceptanceId },
        select: {
          application: {
            select: {
              cycleId: true,
              applicant: { select: { firstName: true, lastName: true, email: true } },
            },
          },
        },
      });
      if (!acceptance) throw new AttendanceEventError("That acceptance no longer exists.");
      // The acceptance id came from this event's own candidate list, but it is a
      // browser-supplied id and the event is the thing being written to: an
      // acceptance from a different cycle is not a candidate here.
      if (acceptance.application.cycleId !== event.cycle?.id) {
        throw new AttendanceEventError("That person was not accepted into this event's cycle.");
      }
      const a = acceptance.application.applicant;
      requested = { name: `${a.firstName} ${a.lastName}`.trim(), email: a.email };
    } else {
      requested = { name: target.name, email: target.email };
    }

    name = requested.name.trim();
    email = requested.email.trim().toLowerCase();
    if (name.length === 0) throw new AttendanceEventError("Give the attendee's name.");
    // An email is required for a walk-up and not for a member, because it is the
    // ONLY thing that can later connect this row to a person -- and the only way
    // to reach them with the nudge. A nameless-but-emailed row is recoverable; an
    // email-less one is a tally mark.
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      throw new AttendanceEventError("Give the attendee a valid email address.");
    }
    contactEmail = email;
    // Someone typed in as a walk-up who actually has an account should become a
    // linked row, not an orphan needing reconciliation later.
    const match = await prisma.person.findFirst({
      where: { contactEmail: { equals: email, mode: "insensitive" } },
      select: { id: true, name: true, contactEmail: true },
    });
    if (match) {
      personId = match.id;
      name = match.name;
      contactEmail = match.contactEmail;
      email = null;
    } else {
      // Asked once and reused: it decides the confirmation below, the blockers
      // further down, and the flag the door reads back, and three separate
      // lookups is three chances for them to disagree about one person.
      onAcceptedList = await isAcceptedApplicantEmail(email, event.cycle?.id ?? null);
      // Hand-typed, no account, and nobody the cycle accepted. That is either a
      // typo in the address or a person who should not be at this session, and
      // both are worth one question at the door -- where the human is standing
      // there to answer it -- rather than a row somebody reconciles in March.
      // An `applicant` target skips this by construction: being on the accepted
      // list is what makes it that shape.
      if (target.kind === "walkUp" && !target.confirmed && !onAcceptedList && event.cycle) {
        throw new CheckInConfirmationRequired(
          `${name} is not on the accepted list for this cycle.`,
        );
      }
    }
  }

  /**
   * Whether an unlinked attendee still needs to APPLY, not just to onboard.
   *
   * Both cases carry the same `contract` blocker key, so the door cannot tell
   * them apart from the key alone -- and the difference is the whole reason it
   * asked a question a moment ago. Without this, the panel tells the operator
   * that the stranger they just admitted needs an onboarding contract, which is
   * true and badly incomplete.
   *
   * False for anyone with a Person: the question does not apply to them.
   */
  const notOnAcceptedList = personId === null && event.cycle !== null && !onAcceptedList;

  const findExisting = () =>
    prisma.eventAttendance.findFirst({
      where: personId ? { eventId, personId } : { eventId, attendeeEmail: email },
      select: { id: true },
    });

  const existing = await findExisting();

  if (existing) {
    // Re-measured, not reported as an empty list. Scanning somebody a second time
    // is how an operator answers "wait, what did you say I still need?", and a
    // door that goes blank on the second scan answers it wrong. Unlinked rows get
    // the same treatment for the same reason: they are the attendees MOST likely
    // to be missing something.
    const blockers = personId
      ? ((await resolveAttendanceBlockers([personId], event.termId)).get(personId) ?? NO_BLOCKERS)
      : onAcceptedList
        ? ACCEPTED_APPLICANT_BLOCKERS
        : WALK_UP_BLOCKERS;
    return {
      attendanceId: existing.id,
      name,
      alreadyCheckedIn: true,
      trainingCredited: event.kind === "TRAINING" && personId !== null,
      blockers: blockers.items,
      blockerKeys: blockers.keys,
      contactEmail,
      notOnAcceptedList,
      nudgeQueued: false,
    };
  }

  // No Person means no clearance to look up, so the honest answer depends only on
  // whether the cycle already accepted this address: someone it did owes a
  // contract, someone it did not owes an application as well. Read off the answer
  // already resolved above rather than asking again, so the message, the
  // confirmation and the door's flag cannot disagree about one person.
  const measured: AttendanceBlockers = personId
    ? ((await resolveAttendanceBlockers([personId], event.termId)).get(personId) ?? NO_BLOCKERS)
    : onAcceptedList
      ? ACCEPTED_APPLICANT_BLOCKERS
      : WALK_UP_BLOCKERS;

  // Clearance is measured BEFORE the transaction below credits this very
  // session, so at a training door it reports the training the attendee is
  // standing in the room for as still outstanding. Told to the operator that is
  // absurd, mailed to the attendee it is worse, and persisted into
  // blockersAtCheckIn it puts somebody with nothing else outstanding into the
  // nudge stream to be resolved on the next cron pass.
  //
  // Subtracted rather than re-measured after the write: the credit and the
  // measurement would have to share a transaction to be re-read consistently,
  // and this is the one blocker whose resolution this function itself is
  // causing, so it is knowable without asking again.
  const blockers = creditsTraining(event, personId)
    ? withoutTrainingKey(measured, event.cycle!.track)
    : measured;

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
          blockerKeys: blockers.keys,
          contactEmail,
          notOnAcceptedList,
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
    blockerKeys: blockers.keys,
    contactEmail,
    notOnAcceptedList,
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
  tx: TransactionClient,
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
