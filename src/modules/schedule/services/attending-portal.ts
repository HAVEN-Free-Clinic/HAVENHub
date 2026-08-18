/**
 * The attending's own view of the attending schedule: what they cover, when they
 * can cover it, and the swap/drop requests they raise against it.
 *
 * The counterpart of services/schedule.ts + services/requests.ts, for faculty.
 * A sibling rather than a widening of those two, because the two schedules are
 * different shapes and the difference is load-bearing:
 *
 *   volunteer  ShiftAssignment    (person, term, DEPARTMENT, date)
 *   attending  ClinicDayAttending (attending, CLINIC DAY, SLOT)
 *
 * An attending belongs to no department, holds no TermMembership, and can cover
 * two COLUMNS of the same Saturday (9am-12pm and RHD Attending) as two separate
 * assignments they can give up independently. Every department-scoped rule in the
 * volunteer services -- publication gating, director approver routing, per-member
 * availability tiers -- has nothing to resolve against here.
 *
 * WHAT IS SHARED: the roster (Attending), the grid (ClinicDayAttending), and the
 * clinic calendar (ClinicDay/Term.clinicDates) all stay exactly as Faculty
 * Relations maintains them. Nothing here becomes a second source of truth for who
 * is covering clinic; an approved request MUTATES the same ClinicDayAttending rows
 * the builder writes.
 *
 * Approval is Faculty Relations' (schedule.manage_attendings). There is no
 * per-department approver to route to, and the whole grid is theirs.
 */

import type { Prisma, ShiftRequestStatus } from "@prisma/client";
import { prisma } from "@/platform/db";
import { recordAudit } from "@/platform/audit";
import { can } from "@/platform/rbac/engine";
import { getActiveTerm } from "@/platform/terms/active-term";
import { getSetting } from "@/platform/settings/service";
import { formatCalendarDate } from "@/platform/dates";
import { queueEmail } from "@/platform/email/send";
import { renderEmail } from "@/platform/email/templates/renderEmail";
import { displayTodayKey } from "@/platform/dates/today";
import { firstNameOf } from "@/platform/person-name";
import { isoDateKey } from "../engine/map";

// ---------------------------------------------------------------------------
// Typed errors
//
// Mirrors requests.ts: pages map these onto a redirect with a message, and
// anything else is a real 500.
// ---------------------------------------------------------------------------

export class AttendingPortalForbiddenError extends Error {
  constructor(message = "You do not have permission to do that.") {
    super(message);
    this.name = "AttendingPortalForbiddenError";
  }
}

export class AttendingPortalValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AttendingPortalValidationError";
  }
}

export class AttendingPortalNotFoundError extends Error {
  constructor(message = "Request not found.") {
    super(message);
    this.name = "AttendingPortalNotFoundError";
  }
}

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/** The roster row behind a signed-in person, when they are faculty. */
export type LinkedAttending = {
  id: string;
  scheduleName: string;
  fullName: string;
  credentials: string | null;
  isActive: boolean;
  specialty: { id: string; code: string; name: string } | null;
};

/**
 * The attending this person signs in as, or null for everyone else.
 *
 * The single question every attending-facing surface asks. Deliberately returns
 * a DEACTIVATED attending too (`isActive` is reported, not filtered): the callers
 * differ on what to do about it -- the schedule page still shows a deactivated
 * attending their past dates, while every write path below refuses -- and a
 * resolver that silently returned null would have made a deactivated attending
 * look like a non-attending, i.e. an ordinary member with an empty schedule.
 */
export async function attendingForPerson(personId: string): Promise<LinkedAttending | null> {
  const row = await prisma.attending.findUnique({
    where: { personId },
    select: {
      id: true,
      scheduleName: true,
      fullName: true,
      credentials: true,
      isActive: true,
      specialty: { select: { id: true, code: true, name: true } },
    },
  });
  return row ?? null;
}

/** Throws unless this person is an ACTIVE attending; returns them otherwise. */
async function requireActiveAttending(personId: string): Promise<LinkedAttending> {
  const attending = await attendingForPerson(personId);
  if (!attending) throw new AttendingPortalForbiddenError("You are not on the attending roster.");
  if (!attending.isActive) {
    throw new AttendingPortalForbiddenError(
      "Your attending record is inactive. Contact Faculty Relations to reactivate it.",
    );
  }
  return attending;
}

/** Whether this person may decide attending swap/drop requests. */
export function canManageAttendingRequests(personId: string): Promise<boolean> {
  return can(personId, "schedule.manage_attendings");
}

// ---------------------------------------------------------------------------
// My attending schedule
// ---------------------------------------------------------------------------

/** One clinic-day column this attending covers. */
export type MyAttendingShift = {
  /** The ClinicDayAttending row, so a request can name exactly this assignment. */
  assignmentId: string;
  clinicDayId: string;
  clinicDate: Date;
  slot: { id: string; label: string; startTime: string; endTime: string };
  /** The other attendings in the same column, if any. */
  alongside: string[];
  /** True when the clinic is closed that Saturday; the row is shown struck out. */
  isClosed: boolean;
  /** True when this attending also holds the on-call week starting that date. */
  onCall: boolean;
};

export type MyAttendingSchedule = {
  attending: LinkedAttending;
  term: { id: string; name: string } | null;
  clinicDates: Date[];
  shifts: MyAttendingShift[];
  /** Dates they have told us they can cover; null when they never have. */
  availableDates: Date[] | null;
  availabilityUpdatedAt: Date | null;
  /** True once the term's clinics have started; the form goes read-only. */
  availabilityLocked: boolean;
  /** Their PENDING requests, keyed "clinicDayId|slotId". */
  pendingRequests: Map<string, PendingAttendingRequest>;
};

export type PendingAttendingRequest = {
  id: string;
  isSwap: boolean;
  note: string | null;
  createdAt: Date;
  target: { name: string; clinicDate: Date; slotLabel: string } | null;
};

/**
 * Everything the attending's own schedule page renders, for the ACTIVE term.
 *
 * One term, not the multi-term span mySchedule does. getPersonTerms resolves the
 * volunteer's working set from their TermMembership rows, which an attending has
 * none of, and there is no attending equivalent of a next-term roster to preview:
 * Faculty Relations builds one grid at a time and the term sheet arrives whole.
 *
 * There is also no publication gate. SchedulePublication is per (term,
 * department); the attending grid has no department to publish, and Faculty
 * Relations already treats the imported sheet as live.
 */
export async function myAttendingSchedule(personId: string): Promise<MyAttendingSchedule | null> {
  const attending = await attendingForPerson(personId);
  if (!attending) return null;

  const term = await getActiveTerm();
  if (!term) {
    return {
      attending,
      term: null,
      clinicDates: [],
      shifts: [],
      availableDates: null,
      availabilityUpdatedAt: null,
      availabilityLocked: false,
      pendingRequests: new Map(),
    };
  }

  const [assignments, availability, pending] = await Promise.all([
    prisma.clinicDayAttending.findMany({
      where: { attendingId: attending.id, clinicDay: { termId: term.id } },
      select: {
        id: true,
        clinicDayId: true,
        slot: { select: { id: true, label: true, startTime: true, endTime: true, order: true } },
        clinicDay: {
          select: {
            clinicDate: true,
            isClosed: true,
            onCallAttendingId: true,
            // Everyone else in the same column, so the card can say who they are
            // covering it with. Deactivated attendings are filtered below rather
            // than in the query: their assignment row survives deactivation by
            // design (see the ClinicDayAttending doc comment), and the grid still
            // shows it -- but a name the roster has retired is not a colleague to
            // hand a shift to.
            attendings: {
              select: {
                slotId: true,
                attendingId: true,
                attending: { select: { scheduleName: true, isActive: true } },
              },
            },
          },
        },
      },
    }),
    prisma.attendingAvailability.findUnique({
      where: { attendingId_termId: { attendingId: attending.id, termId: term.id } },
      select: { dates: true, updatedAt: true },
    }),
    prisma.attendingShiftRequest.findMany({
      where: { requesterId: attending.id, termId: term.id, status: "PENDING" },
      select: {
        id: true,
        note: true,
        createdAt: true,
        requesterDayId: true,
        requesterSlotId: true,
        targetId: true,
        target: { select: { scheduleName: true } },
        targetDay: { select: { clinicDate: true } },
        targetSlot: { select: { label: true } },
      },
    }),
  ]);

  const shifts: MyAttendingShift[] = assignments
    .map((a) => ({
      assignmentId: a.id,
      clinicDayId: a.clinicDayId,
      clinicDate: a.clinicDay.clinicDate,
      slot: {
        id: a.slot.id,
        label: a.slot.label,
        startTime: a.slot.startTime,
        endTime: a.slot.endTime,
      },
      slotOrder: a.slot.order,
      alongside: a.clinicDay.attendings
        .filter((x) => x.slotId === a.slot.id && x.attendingId !== attending.id && x.attending.isActive)
        .map((x) => x.attending.scheduleName)
        .sort((x, y) => x.localeCompare(y)),
      isClosed: a.clinicDay.isClosed,
      onCall: a.clinicDay.onCallAttendingId === attending.id,
    }))
    // Date first, then the grid's own left-to-right column order, so the list
    // reads the way the sheet does for an attending covering two columns.
    .sort((a, b) =>
      a.clinicDate.getTime() !== b.clinicDate.getTime()
        ? a.clinicDate.getTime() - b.clinicDate.getTime()
        : a.slotOrder - b.slotOrder,
    )
    .map(({ slotOrder: _slotOrder, ...rest }) => rest);

  const pendingRequests = new Map<string, PendingAttendingRequest>();
  for (const r of pending) {
    // A swap whose target attending was deleted leaves targetId null with the
    // day/slot possibly still set. Treat the trio as all-or-nothing, exactly as
    // ShiftRequest's doc comment instructs for its own stale-swap shape.
    const isSwap = !!(r.targetId && r.targetDay && r.targetSlot);
    pendingRequests.set(`${r.requesterDayId}|${r.requesterSlotId}`, {
      id: r.id,
      isSwap,
      note: r.note,
      createdAt: r.createdAt,
      target: isSwap
        ? {
            name: r.target?.scheduleName ?? "",
            clinicDate: r.targetDay!.clinicDate,
            slotLabel: r.targetSlot!.label,
          }
        : null,
    });
  }

  return {
    attending,
    term: { id: term.id, name: term.name },
    clinicDates: term.clinicDates,
    shifts,
    availableDates: availability?.dates ?? null,
    availabilityUpdatedAt: availability?.updatedAt ?? null,
    availabilityLocked: await availabilityLocked(term.clinicDates),
    pendingRequests,
  };
}

/**
 * True once the term's first clinic date has arrived.
 *
 * Same rule and same reason as the volunteer side (isAvailabilityLocked): once
 * clinics are running the grid is live, and a change has to go through a request
 * Faculty Relations sees, not a silent edit to a form.
 */
async function availabilityLocked(clinicDates: Date[]): Promise<boolean> {
  if (clinicDates.length === 0) return false;
  const firstKey = clinicDates.map(isoDateKey).reduce((a, b) => (a < b ? a : b));
  return (await displayTodayKey()) >= firstKey;
}

// ---------------------------------------------------------------------------
// Availability
// ---------------------------------------------------------------------------

/**
 * Replace this attending's stated availability for a term.
 *
 * Whole-set replacement, not a merge: the form posts every ticked box, so an
 * unticked date has to be able to mean "no longer".
 *
 * Advisory only. It does NOT touch ClinicDayAttending: Faculty Relations books
 * the grid, and an attending un-ticking a date they are already assigned to does
 * not take them off it (they raise a drop request for that). What it changes is
 * what the builder shows while staffing the NEXT sheet.
 */
export async function updateMyAttendingAvailability(
  actorPersonId: string,
  input: { termId: string; dates: Date[] },
): Promise<void> {
  const attending = await requireActiveAttending(actorPersonId);

  const term = await prisma.term.findUnique({
    where: { id: input.termId },
    select: { id: true, clinicDates: true },
  });
  if (!term) throw new AttendingPortalValidationError("That term no longer exists.");

  const active = await getActiveTerm();
  if (active?.id !== term.id) {
    throw new AttendingPortalValidationError("Availability can only be set for the current term.");
  }

  // A term with no clinic dates has no availability to record. Refuse rather than
  // store the empty submission an empty checkbox grid would post: the row's
  // absence means "never told us" and an empty array means "can cover nothing",
  // and writing the second when the first is true is a lie the builder acts on.
  if (term.clinicDates.length === 0) {
    throw new AttendingPortalValidationError("Clinic dates for this term have not been set yet.");
  }

  if (await availabilityLocked(term.clinicDates)) {
    throw new AttendingPortalValidationError(
      "Availability is locked because clinics have started. Submit a swap or drop request for the date you need to change.",
    );
  }

  const canonicalByKey = new Map(term.clinicDates.map((d) => [isoDateKey(d), d]));

  const seen = new Set<string>();
  for (const d of input.dates) seen.add(isoDateKey(d));

  const bad = [...seen].filter((k) => !canonicalByKey.has(k));
  if (bad.length > 0) {
    throw new AttendingPortalValidationError(
      `The following dates are not clinic dates: ${bad.sort().join(", ")}`,
    );
  }

  // Store the term's own canonical noon-UTC Date objects, never the ones parsed
  // from the form: the whole codebase compares these by UTC day key, and a value
  // that merely lands on the right day at a different time reads as equal here
  // and unequal to a `clinicDate: x` query elsewhere.
  const dates = [...seen].sort().map((k) => canonicalByKey.get(k)!);

  await prisma.attendingAvailability.upsert({
    where: { attendingId_termId: { attendingId: attending.id, termId: term.id } },
    create: { attendingId: attending.id, termId: term.id, dates },
    update: { dates },
  });

  await recordAudit({
    actorPersonId,
    action: "schedule.attending_availability",
    entityType: "Attending",
    entityId: attending.id,
    after: { termId: term.id, dateKeys: [...seen].sort() },
  });
}

/**
 * Stated availability for a term, keyed by attending id, for the builder.
 *
 * Absent from the map = never told us. Present with an empty array = told us they
 * can cover nothing. The two render differently and the caller must keep them
 * apart, which is why this returns a Map rather than defaulting to [].
 */
export async function attendingAvailabilityForTerm(
  termId: string,
): Promise<Map<string, { dateKeys: Set<string>; updatedAt: Date }>> {
  const rows = await prisma.attendingAvailability.findMany({
    where: { termId },
    select: { attendingId: true, dates: true, updatedAt: true },
  });
  return new Map(
    rows.map((r) => [r.attendingId, { dateKeys: new Set(r.dates.map(isoDateKey)), updatedAt: r.updatedAt }]),
  );
}

// ---------------------------------------------------------------------------
// Swap partners
// ---------------------------------------------------------------------------

export type AttendingSwapPartner = {
  attendingId: string;
  name: string;
  clinicDayId: string;
  clinicDate: Date;
  slotId: string;
  slotLabel: string;
};

/**
 * The assignments this attending could offer to trade for, for one of their own.
 *
 * Restricted to the SAME COLUMN, which is the whole eligibility rule and the
 * reason it can be this short. The grid's columns are the clinic's own statement
 * of who may cover what -- "RHD Attending" is staffed by reproductive health
 * faculty, "BHD Clinic" by behavioral health -- so a same-column trade is
 * qualification-preserving by construction, and a cross-column one would let a
 * psychiatrist pick up the reproductive health slot with Faculty Relations'
 * approval standing in for a credentialing check it is not.
 *
 * Also excluded:
 *   - themselves, and any date they ALREADY cover that column on (the swap would
 *     be a no-op or a double-booking)
 *   - closed Saturdays, on both sides
 *   - dates that have already passed
 *   - deactivated attendings, whose assignment rows survive deactivation
 *   - assignments already under a pending request, so two requests cannot be
 *     raised against one seat and both approved
 */
export async function eligibleAttendingSwapPartners(
  personId: string,
  clinicDayId: string,
  slotId: string,
): Promise<AttendingSwapPartner[]> {
  const attending = await attendingForPerson(personId);
  if (!attending?.isActive) return [];

  const term = await getActiveTerm();
  if (!term) return [];

  const todayKey = await displayTodayKey();

  const [rows, mine, pending] = await Promise.all([
    prisma.clinicDayAttending.findMany({
      where: {
        slotId,
        clinicDay: { termId: term.id, isClosed: false },
        attendingId: { not: attending.id },
        attending: { isActive: true },
      },
      select: {
        attendingId: true,
        clinicDayId: true,
        attending: { select: { scheduleName: true } },
        slot: { select: { id: true, label: true } },
        clinicDay: { select: { clinicDate: true } },
      },
    }),
    prisma.clinicDayAttending.findMany({
      where: { attendingId: attending.id, slotId, clinicDay: { termId: term.id } },
      select: { clinicDayId: true },
    }),
    prisma.attendingShiftRequest.findMany({
      where: { termId: term.id, status: "PENDING" },
      select: {
        requesterDayId: true,
        requesterSlotId: true,
        targetDayId: true,
        targetSlotId: true,
      },
    }),
  ]);

  const myDayIds = new Set(mine.map((m) => m.clinicDayId));
  const spokenFor = new Set<string>();
  for (const p of pending) {
    spokenFor.add(`${p.requesterDayId}|${p.requesterSlotId}`);
    if (p.targetDayId && p.targetSlotId) spokenFor.add(`${p.targetDayId}|${p.targetSlotId}`);
  }

  return rows
    .filter((r) => !myDayIds.has(r.clinicDayId))
    .filter((r) => isoDateKey(r.clinicDay.clinicDate) >= todayKey)
    .filter((r) => !spokenFor.has(`${r.clinicDayId}|${r.slot.id}`))
    .map((r) => ({
      attendingId: r.attendingId,
      name: r.attending.scheduleName,
      clinicDayId: r.clinicDayId,
      clinicDate: r.clinicDay.clinicDate,
      slotId: r.slot.id,
      slotLabel: r.slot.label,
    }))
    .sort(
      (a, b) =>
        a.clinicDate.getTime() - b.clinicDate.getTime() || a.name.localeCompare(b.name),
    );
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

/**
 * Raise a swap or drop against one of the caller's own assignments.
 *
 * Drop when `target` is omitted; named swap otherwise. Nothing on the grid moves
 * here -- approval does that -- so this is deliberately additive: the attending
 * stays on the schedule, and the clinic keeps its coverage, until Faculty
 * Relations says otherwise.
 */
export async function createAttendingRequest(
  actorPersonId: string,
  input: {
    clinicDayId: string;
    slotId: string;
    target?: { attendingId: string; clinicDayId: string; slotId: string };
    note?: string;
  },
): Promise<{ id: string }> {
  const attending = await requireActiveAttending(actorPersonId);

  const term = await getActiveTerm();
  if (!term) throw new AttendingPortalValidationError("There is no active term.");

  const todayKey = await displayTodayKey();

  // The caller must actually hold the assignment they are giving up. Checked
  // against ClinicDayAttending rather than against anything they posted, so a
  // stale tab or a crafted form cannot raise a request on somebody else's seat.
  const own = await prisma.clinicDayAttending.findFirst({
    where: {
      attendingId: attending.id,
      clinicDayId: input.clinicDayId,
      slotId: input.slotId,
      clinicDay: { termId: term.id },
    },
    select: { clinicDay: { select: { clinicDate: true, isClosed: true } }, slot: { select: { label: true } } },
  });
  if (!own) {
    throw new AttendingPortalValidationError("You are not scheduled for that slot.");
  }
  if (own.clinicDay.isClosed) {
    throw new AttendingPortalValidationError("The clinic is closed that day.");
  }
  // >= today: a same-day request on the morning of clinic is a real case, so only
  // a fully elapsed date is refused. Same rule as the volunteer flow.
  if (isoDateKey(own.clinicDay.clinicDate) < todayKey) {
    throw new AttendingPortalValidationError("That clinic date has already passed.");
  }

  let target: { attendingId: string; clinicDayId: string; slotId: string; clinicDate: Date; label: string; name: string } | null =
    null;

  if (input.target) {
    if (input.target.slotId !== input.slotId) {
      // Not merely a UI constraint: see eligibleAttendingSwapPartners on why the
      // column IS the qualification.
      throw new AttendingPortalValidationError("A swap has to be for the same schedule column.");
    }
    if (input.target.attendingId === attending.id) {
      throw new AttendingPortalValidationError("You cannot swap with yourself.");
    }
    const row = await prisma.clinicDayAttending.findFirst({
      where: {
        attendingId: input.target.attendingId,
        clinicDayId: input.target.clinicDayId,
        slotId: input.target.slotId,
        clinicDay: { termId: term.id },
      },
      select: {
        attending: { select: { scheduleName: true, isActive: true } },
        clinicDay: { select: { clinicDate: true, isClosed: true } },
        slot: { select: { label: true } },
      },
    });
    if (!row) {
      throw new AttendingPortalValidationError("That attending is not scheduled for the slot you picked.");
    }
    if (!row.attending.isActive) {
      throw new AttendingPortalValidationError("That attending is no longer active.");
    }
    if (row.clinicDay.isClosed) {
      throw new AttendingPortalValidationError("The clinic is closed on the date you picked.");
    }
    if (isoDateKey(row.clinicDay.clinicDate) < todayKey) {
      throw new AttendingPortalValidationError("That clinic date has already passed.");
    }
    // Neither side may already cover the other's date in this column, or approving
    // the swap would try to put one of them in the same seat twice.
    const collision = await prisma.clinicDayAttending.findFirst({
      where: {
        slotId: input.slotId,
        OR: [
          { attendingId: attending.id, clinicDayId: input.target.clinicDayId },
          { attendingId: input.target.attendingId, clinicDayId: input.clinicDayId },
        ],
      },
      select: { id: true },
    });
    if (collision) {
      throw new AttendingPortalValidationError(
        "One of you already covers that column on the other's date, so the swap would double-book.",
      );
    }
    target = {
      attendingId: input.target.attendingId,
      clinicDayId: input.target.clinicDayId,
      slotId: input.target.slotId,
      clinicDate: row.clinicDay.clinicDate,
      label: row.slot.label,
      name: row.attending.scheduleName,
    };
  }

  let created: { id: string };
  try {
    created = await prisma.$transaction(async (tx) => {
      const existing = await tx.attendingShiftRequest.findFirst({
        where: {
          requesterId: attending.id,
          requesterDayId: input.clinicDayId,
          requesterSlotId: input.slotId,
          status: "PENDING",
        },
        select: { id: true },
      });
      if (existing) {
        throw new AttendingPortalValidationError("You already have a pending request for that slot.");
      }
      // The other side must not be spoken for either: two attendings each
      // proposing a swap INTO the same seat would both validate here and both
      // apply on approval. Nothing in the DB can express that one, so it is
      // re-checked at approval time too.
      if (target) {
        const claimed = await tx.attendingShiftRequest.findFirst({
          where: {
            status: "PENDING",
            targetDayId: target.clinicDayId,
            targetSlotId: target.slotId,
          },
          select: { id: true },
        });
        if (claimed) {
          throw new AttendingPortalValidationError(
            "Someone else has already asked to swap for that slot. Try another date.",
          );
        }
      }
      return tx.attendingShiftRequest.create({
        data: {
          termId: term.id,
          requesterId: attending.id,
          requesterDayId: input.clinicDayId,
          requesterSlotId: input.slotId,
          targetId: target?.attendingId ?? null,
          targetDayId: target?.clinicDayId ?? null,
          targetSlotId: target?.slotId ?? null,
          note: input.note?.trim() || null,
          status: "PENDING",
        },
        select: { id: true },
      });
    });
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      throw new AttendingPortalValidationError("You already have a pending request for that slot.");
    }
    throw err;
  }

  await recordAudit({
    actorPersonId,
    action: "schedule.attending_request",
    entityType: "AttendingShiftRequest",
    entityId: created.id,
    after: {
      type: target ? "swap" : "drop",
      dateKey: isoDateKey(own.clinicDay.clinicDate),
      slotLabel: own.slot.label,
      targetAttendingId: target?.attendingId ?? null,
      targetDateKey: target ? isoDateKey(target.clinicDate) : null,
    },
  });

  await notifyRequestSubmitted({
    actorPersonId,
    requesterName: attending.scheduleName,
    requesterDate: own.clinicDay.clinicDate,
    slotLabel: own.slot.label,
    target,
    note: input.note?.trim() || "",
  });

  return created;
}

/** Withdraw one's own pending request. Nothing on the grid ever moved, so this
 *  only closes the row. */
export async function cancelAttendingRequest(actorPersonId: string, requestId: string): Promise<void> {
  const attending = await attendingForPerson(actorPersonId);
  if (!attending) throw new AttendingPortalForbiddenError("You are not on the attending roster.");

  const req = await prisma.attendingShiftRequest.findUnique({
    where: { id: requestId },
    select: { id: true, requesterId: true, status: true },
  });
  if (!req) throw new AttendingPortalNotFoundError();
  if (req.requesterId !== attending.id) throw new AttendingPortalForbiddenError();
  if (req.status !== "PENDING") {
    throw new AttendingPortalValidationError("Only a pending request can be withdrawn.");
  }

  await prisma.attendingShiftRequest.update({
    where: { id: requestId },
    data: { status: "CANCELLED" },
  });

  await recordAudit({
    actorPersonId,
    action: "schedule.attending_request_cancel",
    entityType: "AttendingShiftRequest",
    entityId: requestId,
    after: { status: "CANCELLED" },
  });
}

/** One pending or decided request, as Faculty Relations' queue renders it. */
export type AttendingRequestRow = {
  id: string;
  status: ShiftRequestStatus;
  isSwap: boolean;
  note: string | null;
  createdAt: Date;
  decidedAt: Date | null;
  requester: { id: string; name: string };
  requesterDate: Date;
  requesterSlotLabel: string;
  target: { id: string; name: string; clinicDate: Date; slotLabel: string } | null;
};

/**
 * The attending request queue. Clinic-wide: unlike listDepartmentRequests there
 * is nothing to scope by, because attendings belong to no department.
 */
export async function listAttendingRequests(
  personId: string,
  opts: { status?: ShiftRequestStatus } = {},
): Promise<AttendingRequestRow[]> {
  if (!(await canManageAttendingRequests(personId))) throw new AttendingPortalForbiddenError();

  const term = await getActiveTerm();
  if (!term) return [];

  const rows = await prisma.attendingShiftRequest.findMany({
    where: { termId: term.id, ...(opts.status ? { status: opts.status } : {}) },
    select: {
      id: true,
      status: true,
      note: true,
      createdAt: true,
      decidedAt: true,
      requesterId: true,
      requester: { select: { scheduleName: true } },
      requesterDay: { select: { clinicDate: true } },
      requesterSlot: { select: { label: true } },
      targetId: true,
      target: { select: { scheduleName: true } },
      targetDay: { select: { clinicDate: true } },
      targetSlot: { select: { label: true } },
    },
    // Pending first, then oldest first inside each group: a queue is worked in
    // the order it arrived, and a decided row is history.
    orderBy: [{ status: "asc" }, { createdAt: "asc" }],
  });

  return rows.map((r) => {
    const isSwap = !!(r.targetId && r.targetDay && r.targetSlot);
    return {
      id: r.id,
      status: r.status,
      isSwap,
      note: r.note,
      createdAt: r.createdAt,
      decidedAt: r.decidedAt,
      requester: { id: r.requesterId, name: r.requester.scheduleName },
      requesterDate: r.requesterDay.clinicDate,
      requesterSlotLabel: r.requesterSlot.label,
      target: isSwap
        ? {
            id: r.targetId!,
            name: r.target?.scheduleName ?? "",
            clinicDate: r.targetDay!.clinicDate,
            slotLabel: r.targetSlot!.label,
          }
        : null,
    };
  });
}

/**
 * Approve a request, applying it to the grid in the same transaction.
 *
 * A swap exchanges the two ClinicDayAttending rows' clinic days; a drop deletes
 * the requester's row and leaves the column short, which is exactly what the
 * coverage view is for.
 *
 * Everything is re-validated here rather than trusted from creation time: the
 * grid is edited by hand between a request being raised and being decided, and
 * an approval that blindly replayed a stale plan would write a schedule nobody
 * asked for.
 */
export async function approveAttendingRequest(actorPersonId: string, requestId: string): Promise<void> {
  if (!(await canManageAttendingRequests(actorPersonId))) throw new AttendingPortalForbiddenError();

  const req = await prisma.attendingShiftRequest.findUnique({
    where: { id: requestId },
    select: {
      id: true,
      status: true,
      termId: true,
      requesterId: true,
      requesterDayId: true,
      requesterSlotId: true,
      targetId: true,
      targetDayId: true,
      targetSlotId: true,
      requester: { select: { scheduleName: true, person: { select: { contactEmail: true, id: true } } } },
      requesterDay: { select: { clinicDate: true } },
      requesterSlot: { select: { label: true } },
      target: { select: { scheduleName: true, person: { select: { contactEmail: true, id: true } } } },
      targetDay: { select: { clinicDate: true } },
    },
  });
  if (!req) throw new AttendingPortalNotFoundError();
  if (req.status !== "PENDING") {
    throw new AttendingPortalValidationError("Only a pending request can be approved.");
  }

  const isSwap = !!(req.targetId && req.targetDayId && req.targetSlotId);

  // Past-date guard, mirroring approveRequest: approving a drop DELETES the
  // assignment row, which is the record that this attending covered that day.
  // Once the date has elapsed that is history, not a schedule change. Deny stays
  // available (it writes no grid row), which is why the message names it.
  const todayKey = await displayTodayKey();
  const staleRequesterDate = isoDateKey(req.requesterDay.clinicDate) < todayKey;
  const staleTargetDate = req.targetDay ? isoDateKey(req.targetDay.clinicDate) < todayKey : false;
  if (staleRequesterDate || staleTargetDate) {
    throw new AttendingPortalValidationError(
      "This request is for a clinic date that has already passed. Deny it instead.",
    );
  }

  await prisma.$transaction(async (tx) => {
    const mine = await tx.clinicDayAttending.findFirst({
      where: {
        attendingId: req.requesterId,
        clinicDayId: req.requesterDayId,
        slotId: req.requesterSlotId,
      },
      select: { id: true },
    });
    if (!mine) {
      throw new AttendingPortalValidationError(
        "The schedule changed: that attending no longer covers the slot they asked to give up.",
      );
    }

    if (isSwap) {
      const theirs = await tx.clinicDayAttending.findFirst({
        where: {
          attendingId: req.targetId!,
          clinicDayId: req.targetDayId!,
          slotId: req.targetSlotId!,
        },
        select: { id: true, order: true },
      });
      if (!theirs) {
        throw new AttendingPortalValidationError(
          "The schedule changed: the swap partner no longer covers that slot.",
        );
      }

      // Re-assert both attendings are still ACTIVE. The assignment rows outlive
      // deactivation by design, so without this a retired doctor could be swapped
      // onto a future date. Mirrors approveRequest's active-membership re-check.
      const stillActive = await tx.attending.count({
        where: { id: { in: [req.requesterId, req.targetId!] }, isActive: true },
      });
      if (stillActive !== 2) {
        throw new AttendingPortalValidationError(
          "One of the attendings is no longer active and cannot be scheduled.",
        );
      }

      // Neither may already hold the other's date in this column. Re-checked here
      // and not only at creation: the DB's partial unique index guards duplicate
      // PENDING rows, not the grid edits made in between.
      const collision = await tx.clinicDayAttending.findFirst({
        where: {
          slotId: req.requesterSlotId,
          OR: [
            { attendingId: req.requesterId, clinicDayId: req.targetDayId! },
            { attendingId: req.targetId!, clinicDayId: req.requesterDayId },
          ],
        },
        select: { id: true },
      });
      if (collision) {
        throw new AttendingPortalValidationError(
          "The schedule changed: one of them now already covers the other's date, so the swap would double-book.",
        );
      }

      // Move each row to the other's clinic day. Updating the two rows in place
      // (rather than delete + create) keeps their `order` within the column, so a
      // two-attending slot does not silently reshuffle on every swap.
      await tx.clinicDayAttending.update({
        where: { id: mine.id },
        data: { clinicDayId: req.targetDayId! },
      });
      await tx.clinicDayAttending.update({
        where: { id: theirs.id },
        data: { clinicDayId: req.requesterDayId },
      });
    } else {
      const { count } = await tx.clinicDayAttending.deleteMany({ where: { id: mine.id } });
      if (count !== 1) {
        throw new AttendingPortalValidationError("Schedule changed while approving; please retry.");
      }
    }

    await tx.attendingShiftRequest.update({
      where: { id: req.id },
      data: { status: "APPROVED", decidedById: actorPersonId, decidedAt: new Date() },
    });
  });

  await recordAudit({
    actorPersonId,
    action: "schedule.attending_request_approve",
    entityType: "AttendingShiftRequest",
    entityId: req.id,
    after: { type: isSwap ? "swap" : "drop", status: "APPROVED" },
  });

  await notifyDecision(req, "approved", actorPersonId);
}

/** Deny a request. Writes no grid row, so unlike approval it has no past-date
 *  guard: a stale request still has to be closable. */
export async function denyAttendingRequest(actorPersonId: string, requestId: string): Promise<void> {
  if (!(await canManageAttendingRequests(actorPersonId))) throw new AttendingPortalForbiddenError();

  const req = await prisma.attendingShiftRequest.findUnique({
    where: { id: requestId },
    select: {
      id: true,
      status: true,
      targetId: true,
      targetDayId: true,
      targetSlotId: true,
      requester: { select: { scheduleName: true, person: { select: { contactEmail: true, id: true } } } },
      requesterDay: { select: { clinicDate: true } },
      requesterSlot: { select: { label: true } },
      target: { select: { scheduleName: true, person: { select: { contactEmail: true, id: true } } } },
      targetDay: { select: { clinicDate: true } },
    },
  });
  if (!req) throw new AttendingPortalNotFoundError();
  if (req.status !== "PENDING") {
    throw new AttendingPortalValidationError("Only a pending request can be denied.");
  }

  await prisma.attendingShiftRequest.update({
    where: { id: requestId },
    data: { status: "DENIED", decidedById: actorPersonId, decidedAt: new Date() },
  });

  await recordAudit({
    actorPersonId,
    action: "schedule.attending_request_deny",
    entityType: "AttendingShiftRequest",
    entityId: requestId,
    after: { status: "DENIED" },
  });

  await notifyDecision(req, "denied", actorPersonId);
}

/** Pending attending requests awaiting Faculty Relations, for the nav badge. */
export async function countPendingAttendingRequests(personId: string): Promise<number> {
  if (!(await canManageAttendingRequests(personId))) return 0;
  const term = await getActiveTerm();
  if (!term) return 0;
  return prisma.attendingShiftRequest.count({ where: { termId: term.id, status: "PENDING" } });
}

// ---------------------------------------------------------------------------
// Notifications
//
// Best-effort throughout, exactly like the volunteer request flow: a mail
// failure must never roll back a decision that has already been written.
// ---------------------------------------------------------------------------

function fmtEmailDate(d: Date): string {
  return formatCalendarDate(d, { month: "long", day: "numeric", year: "numeric" });
}

async function sendAttendingEmail(
  templateKey: string,
  to: string | null | undefined,
  personId: string | null,
  triggeredById: string,
  vars: Record<string, string>,
): Promise<void> {
  if (!to) return;
  try {
    const baseUrl = await getSetting<string>("app.baseUrl");
    const { subject, html } = await renderEmail(templateKey, {
      scheduleUrl: `${baseUrl}/schedule`,
      requestsUrl: `${baseUrl}/schedule/requests`,
      ...vars,
    });
    await queueEmail(prisma, { to, subject, html, template: templateKey, personId, triggeredById });
  } catch {
    // Best-effort: never block the domain mutation on email failure.
  }
}

/**
 * Faculty Relations' address book for these requests.
 *
 * Resolved from the PERMISSION rather than from a settings field, so it follows
 * whoever actually holds the job this term. Everyone holding
 * schedule.manage_attendings is an approver, which is precisely the authority
 * approveAttendingRequest enforces.
 *
 * Two steps, because the RBAC engine only answers "may THIS person?" and has no
 * reverse index. Step one narrows to CANDIDATES straight from RoleAssignment --
 * the rows whose role grants the permission (or "*"), resolved through each
 * target shape the engine honours. Step two runs the real `can()` over that short
 * list, so the engine stays the single decider and this cannot drift from it. The
 * narrowing matters: without it this is one permission evaluation per active
 * person in the clinic, on a path that runs inside a request submission.
 */
async function requestApprovers(): Promise<Array<{ id: string; name: string; contactEmail: string | null }>> {
  const term = await getActiveTerm();

  const assignments = await prisma.roleAssignment.findMany({
    where: {
      OR: [{ termId: null }, ...(term ? [{ termId: term.id }] : [])],
      role: { grants: { some: { permission: { in: ["schedule.manage_attendings", "*"] } } } },
    },
    select: { personId: true, departmentId: true, kind: true },
  });
  if (assignments.length === 0) return [];

  const candidateIds = new Set<string>();
  for (const a of assignments.filter((a) => a.personId)) candidateIds.add(a.personId!);

  // Department- and kind-targeted assignments reach whoever holds a matching
  // ACTIVE membership this term, so expand them the same way the engine does.
  const departmentIds = [...new Set(assignments.map((a) => a.departmentId).filter((d): d is string => !!d))];
  const kinds = [...new Set(assignments.map((a) => a.kind).filter((k): k is NonNullable<typeof k> => !!k))];
  if (term && (departmentIds.length > 0 || kinds.length > 0)) {
    const members = await prisma.termMembership.findMany({
      where: {
        termId: term.id,
        status: "ACTIVE",
        OR: [
          ...(departmentIds.length ? [{ departmentId: { in: departmentIds } }] : []),
          ...(kinds.length ? [{ kind: { in: kinds } }] : []),
        ],
      },
      select: { personId: true },
    });
    for (const m of members) candidateIds.add(m.personId);
  }
  if (candidateIds.size === 0) return [];

  const people = await prisma.person.findMany({
    where: { id: { in: [...candidateIds] }, status: "ACTIVE", contactEmail: { not: null } },
    select: { id: true, name: true, contactEmail: true },
  });
  const flags = await Promise.all(people.map((p) => can(p.id, "schedule.manage_attendings")));
  return people.filter((_, i) => flags[i]);
}

async function notifyRequestSubmitted(input: {
  actorPersonId: string;
  requesterName: string;
  requesterDate: Date;
  slotLabel: string;
  target: { name: string; clinicDate: Date; label: string; attendingId: string } | null;
  note: string;
}): Promise<void> {
  try {
    const approvers = await requestApprovers();
    await Promise.all(
      approvers.map((a) =>
        sendAttendingEmail("attending-request-submitted", a.contactEmail, a.id, input.actorPersonId, {
          recipientName: firstNameOf(a.name),
          requesterName: input.requesterName,
          requestType: input.target ? "swap" : "drop",
          requesterDate: fmtEmailDate(input.requesterDate),
          slotLabel: input.slotLabel,
          partnerName: input.target?.name ?? "",
          partnerDate: input.target ? fmtEmailDate(input.target.clinicDate) : "",
          note: input.note,
        }),
      ),
    );
  } catch {
    // Best-effort.
  }
}

type DecisionRequest = {
  targetId: string | null;
  targetDayId: string | null;
  targetSlotId: string | null;
  requester: { scheduleName: string; person: { contactEmail: string | null; id: string } | null };
  requesterDay: { clinicDate: Date };
  requesterSlot: { label: string };
  target: { scheduleName: string; person: { contactEmail: string | null; id: string } | null } | null;
  targetDay: { clinicDate: Date } | null;
};

/**
 * Tell both sides what happened.
 *
 * The swap partner is emailed too, and only through their Hub account: an
 * attending who has never been given Hub access has `person` null, and mailing
 * their roster address about a decision they cannot see or act on would be worse
 * than silence. Faculty Relations still has the queue.
 */
async function notifyDecision(
  req: DecisionRequest,
  outcome: "approved" | "denied",
  actorPersonId: string,
): Promise<void> {
  try {
    const isSwap = !!(req.targetId && req.targetDayId && req.targetSlotId);
    const templateKey = outcome === "approved" ? "attending-request-approved" : "attending-request-denied";
    const shared = {
      requestType: isSwap ? "swap" : "drop",
      requesterDate: fmtEmailDate(req.requesterDay.clinicDate),
      slotLabel: req.requesterSlot.label,
      partnerDate: req.targetDay ? fmtEmailDate(req.targetDay.clinicDate) : "",
    };
    await Promise.all([
      sendAttendingEmail(templateKey, req.requester.person?.contactEmail, req.requester.person?.id ?? null, actorPersonId, {
        ...shared,
        recipientName: req.requester.scheduleName,
        otherName: req.target?.scheduleName ?? "",
      }),
      isSwap && req.target
        ? sendAttendingEmail(templateKey, req.target.person?.contactEmail, req.target.person?.id ?? null, actorPersonId, {
            ...shared,
            recipientName: req.target.scheduleName,
            otherName: req.requester.scheduleName,
          })
        : Promise.resolve(),
    ]);
  } catch {
    // Best-effort.
  }
}

function isUniqueConstraintError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as Prisma.PrismaClientKnownRequestError).code === "P2002"
  );
}
