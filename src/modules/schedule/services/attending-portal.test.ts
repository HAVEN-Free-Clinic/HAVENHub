import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import {
  attendingForPerson,
  myAttendingSchedule,
  updateMyAttendingAvailability,
  attendingAvailabilityForTerm,
  eligibleAttendingSwapPartners,
  createAttendingRequest,
  cancelAttendingRequest,
  listAttendingRequests,
  approveAttendingRequest,
  denyAttendingRequest,
  countPendingAttendingRequests,
  AttendingPortalForbiddenError,
  AttendingPortalValidationError,
} from "./attending-portal";

/**
 * Dates are deliberately FAR future / FAR past rather than relative to now:
 * every guard in this service compares against displayTodayKey(), which reads
 * the real clock, and a date computed from `new Date()` in a fixture would drift
 * across a term boundary or a DST edge and make the suite fail on a calendar day
 * rather than on a code change.
 */
const FUTURE = ["2099-05-02", "2099-05-09", "2099-05-16"];
const PAST = ["2020-05-02", "2020-05-09"];

const FCRL = "fcrl-1";

async function activeTerm(dateKeys: string[]) {
  return prisma.term.create({
    data: {
      code: "SU99",
      name: "Summer 2099",
      status: "ACTIVE",
      startDate: new Date("2099-05-01T12:00:00Z"),
      endDate: new Date("2099-08-31T12:00:00Z"),
      clinicDates: dateKeys.map((k) => new Date(`${k}T12:00:00Z`)),
    },
  });
}

async function slot(label: string, order: number, allowsMultiple = false) {
  return prisma.clinicSlot.create({
    data: { label, startTime: "09:00", endTime: "12:00", order, allowsMultiple },
  });
}

async function clinicDay(termId: string, dateKey: string, extra: { isClosed?: boolean } = {}) {
  return prisma.clinicDay.create({
    data: { termId, clinicDate: new Date(`${dateKey}T12:00:00Z`), isClosed: extra.isClosed ?? false },
  });
}

/** An attending, optionally with a linked Hub account. */
async function attending(name: string, opts: { withPerson?: boolean; isActive?: boolean } = {}) {
  const person = opts.withPerson
    ? await prisma.person.create({ data: { name, contactEmail: `${name.replace(/\s+/g, "").toLowerCase()}@yale.edu` } })
    : null;
  const row = await prisma.attending.create({
    data: {
      scheduleName: name,
      fullName: name,
      isActive: opts.isActive ?? true,
      personId: person?.id ?? null,
    },
  });
  return { attending: row, personId: person?.id ?? "" };
}

async function assign(attendingId: string, clinicDayId: string, slotId: string) {
  return prisma.clinicDayAttending.create({ data: { attendingId, clinicDayId, slotId } });
}

/** Give FCRL the permission that decides attending requests. */
async function grantManageAttendings(personId = FCRL) {
  await prisma.person.upsert({
    where: { id: personId },
    update: {},
    create: { id: personId, name: "FCRL Director", contactEmail: `${personId}@example.edu` },
  });
  const role = await prisma.role.create({
    data: {
      name: `r-${personId}`,
      isSystem: false,
      grants: { create: [{ permission: "schedule.manage_attendings" }] },
    },
  });
  await prisma.roleAssignment.create({ data: { roleId: role.id, personId, termId: null } });
}

beforeEach(resetDb);

// ---------------------------------------------------------------------------

describe("attendingForPerson", () => {
  it("resolves the roster row behind a linked person", async () => {
    const { attending: a, personId } = await attending("Peggy Bia", { withPerson: true });
    expect((await attendingForPerson(personId))?.id).toBe(a.id);
  });

  it("is null for someone who is not an attending", async () => {
    const p = await prisma.person.create({ data: { name: "Volunteer" } });
    expect(await attendingForPerson(p.id)).toBeNull();
  });

  /**
   * Deactivation must not read as "not an attending". The two states get
   * different treatment everywhere downstream: a deactivated attending still
   * sees their past dates, but every write path refuses them.
   */
  it("still resolves a DEACTIVATED attending, reporting isActive", async () => {
    const { personId } = await attending("Retired Doc", { withPerson: true, isActive: false });
    const resolved = await attendingForPerson(personId);
    expect(resolved).not.toBeNull();
    expect(resolved!.isActive).toBe(false);
  });
});

describe("myAttendingSchedule", () => {
  it("returns null for a non-attending, so the page renders nothing", async () => {
    const p = await prisma.person.create({ data: { name: "Volunteer" } });
    expect(await myAttendingSchedule(p.id)).toBeNull();
  });

  it("lists the dates and columns they cover, with who else is in the column", async () => {
    const term = await activeTerm(FUTURE);
    const morning = await slot("9am-12pm", 0, true);
    const day = await clinicDay(term.id, FUTURE[0]);
    const { attending: mine, personId } = await attending("Peggy Bia", { withPerson: true });
    const { attending: other } = await attending("Frank Bia");
    await assign(mine.id, day.id, morning.id);
    await assign(other.id, day.id, morning.id);

    const s = await myAttendingSchedule(personId);
    expect(s!.shifts).toHaveLength(1);
    expect(s!.shifts[0].slot.label).toBe("9am-12pm");
    expect(s!.shifts[0].alongside).toEqual(["Frank Bia"]);
  });

  /**
   * A deactivated attending's assignment row survives by design, so the grid can
   * still show the gap. It must not appear as a colleague on someone's card.
   */
  it("omits a deactivated attending from the 'covering with' list", async () => {
    const term = await activeTerm(FUTURE);
    const morning = await slot("9am-12pm", 0, true);
    const day = await clinicDay(term.id, FUTURE[0]);
    const { attending: mine, personId } = await attending("Peggy Bia", { withPerson: true });
    const { attending: retired } = await attending("Retired Doc", { isActive: false });
    await assign(mine.id, day.id, morning.id);
    await assign(retired.id, day.id, morning.id);

    const s = await myAttendingSchedule(personId);
    expect(s!.shifts[0].alongside).toEqual([]);
  });

  it("orders by date, then by the grid's own column order", async () => {
    const term = await activeTerm(FUTURE);
    const first = await slot("9am-12pm", 0);
    const second = await slot("11am-2pm", 1);
    const dayA = await clinicDay(term.id, FUTURE[0]);
    const dayB = await clinicDay(term.id, FUTURE[1]);
    const { attending: mine, personId } = await attending("Peggy Bia", { withPerson: true });
    // Created out of order on purpose.
    await assign(mine.id, dayB.id, first.id);
    await assign(mine.id, dayA.id, second.id);
    await assign(mine.id, dayA.id, first.id);

    const s = await myAttendingSchedule(personId);
    expect(s!.shifts.map((x) => [x.clinicDate.toISOString().slice(0, 10), x.slot.label])).toEqual([
      [FUTURE[0], "9am-12pm"],
      [FUTURE[0], "11am-2pm"],
      [FUTURE[1], "9am-12pm"],
    ]);
  });

  it("marks the on-call week and a closed clinic day", async () => {
    const term = await activeTerm(FUTURE);
    const morning = await slot("9am-12pm", 0);
    const { attending: mine, personId } = await attending("Peggy Bia", { withPerson: true });
    const day = await prisma.clinicDay.create({
      data: {
        termId: term.id,
        clinicDate: new Date(`${FUTURE[0]}T12:00:00Z`),
        isClosed: true,
        onCallAttendingId: mine.id,
      },
    });
    await assign(mine.id, day.id, morning.id);

    const s = await myAttendingSchedule(personId);
    expect(s!.shifts[0].onCall).toBe(true);
    expect(s!.shifts[0].isClosed).toBe(true);
  });
});

describe("updateMyAttendingAvailability", () => {
  it("stores the term's canonical dates and reads back through the schedule", async () => {
    const term = await activeTerm(FUTURE);
    const { personId } = await attending("Peggy Bia", { withPerson: true });

    await updateMyAttendingAvailability(personId, {
      termId: term.id,
      // A different time-of-day on the right day: the service must store the
      // term's own noon-UTC value, not what the form parsed.
      dates: [new Date(`${FUTURE[0]}T23:30:00Z`)],
    });

    const s = await myAttendingSchedule(personId);
    expect(s!.availableDates!.map((d) => d.toISOString())).toEqual([`${FUTURE[0]}T12:00:00.000Z`]);
  });

  it("replaces the whole set, so un-ticking a date removes it", async () => {
    const term = await activeTerm(FUTURE);
    const { personId } = await attending("Peggy Bia", { withPerson: true });
    const at = (k: string) => new Date(`${k}T12:00:00Z`);

    await updateMyAttendingAvailability(personId, { termId: term.id, dates: [at(FUTURE[0]), at(FUTURE[1])] });
    await updateMyAttendingAvailability(personId, { termId: term.id, dates: [at(FUTURE[1])] });

    const s = await myAttendingSchedule(personId);
    expect(s!.availableDates!.map((d) => d.toISOString().slice(0, 10))).toEqual([FUTURE[1]]);
  });

  it("rejects a date that is not a clinic date", async () => {
    const term = await activeTerm(FUTURE);
    const { personId } = await attending("Peggy Bia", { withPerson: true });
    await expect(
      updateMyAttendingAvailability(personId, { termId: term.id, dates: [new Date("2099-07-04T12:00:00Z")] }),
    ).rejects.toThrow(AttendingPortalValidationError);
  });

  /**
   * The row's ABSENCE means "never told us" and an empty array means "can cover
   * nothing". Writing the second when the calendar is simply empty would be a
   * lie the builder acts on, so the empty-calendar case is refused outright.
   */
  it("refuses to record availability for a term with no clinic dates", async () => {
    const term = await activeTerm([]);
    const { personId } = await attending("Peggy Bia", { withPerson: true });
    await expect(
      updateMyAttendingAvailability(personId, { termId: term.id, dates: [] }),
    ).rejects.toThrow(/clinic dates/i);
    expect(await prisma.attendingAvailability.count()).toBe(0);
  });

  it("locks once the term's clinics have started", async () => {
    const term = await activeTerm(PAST);
    const { personId } = await attending("Peggy Bia", { withPerson: true });
    await expect(
      updateMyAttendingAvailability(personId, {
        termId: term.id,
        dates: [new Date(`${PAST[0]}T12:00:00Z`)],
      }),
    ).rejects.toThrow(/locked/i);
  });

  it("refuses a deactivated attending", async () => {
    const term = await activeTerm(FUTURE);
    const { personId } = await attending("Retired Doc", { withPerson: true, isActive: false });
    await expect(
      updateMyAttendingAvailability(personId, { termId: term.id, dates: [] }),
    ).rejects.toThrow(AttendingPortalForbiddenError);
  });

  it("refuses someone who is not an attending at all", async () => {
    const term = await activeTerm(FUTURE);
    const p = await prisma.person.create({ data: { name: "Volunteer" } });
    await expect(
      updateMyAttendingAvailability(p.id, { termId: term.id, dates: [] }),
    ).rejects.toThrow(AttendingPortalForbiddenError);
  });
});

describe("attendingAvailabilityForTerm", () => {
  /**
   * "Never told us" and "told us nothing works" are different answers, and the
   * builder annotates them differently. A Map that defaulted a missing row to []
   * would collapse them.
   */
  it("keeps 'never submitted' distinct from 'submitted nothing'", async () => {
    const term = await activeTerm(FUTURE);
    const { attending: silent } = await attending("Silent Doc");
    const { attending: none, personId: nonePid } = await attending("Busy Doc", { withPerson: true });
    await prisma.attendingAvailability.create({ data: { attendingId: none.id, termId: term.id, dates: [] } });
    void nonePid;

    const map = await attendingAvailabilityForTerm(term.id);
    expect(map.has(silent.id)).toBe(false);
    expect(map.get(none.id)!.dateKeys.size).toBe(0);
  });
});

describe("eligibleAttendingSwapPartners", () => {
  it("offers only the SAME column on other dates", async () => {
    const term = await activeTerm(FUTURE);
    const morning = await slot("9am-12pm", 0);
    const rhd = await slot("RHD Attending", 1);
    const dayA = await clinicDay(term.id, FUTURE[0]);
    const dayB = await clinicDay(term.id, FUTURE[1]);
    const { attending: mine, personId } = await attending("Peggy Bia", { withPerson: true });
    const { attending: sameCol } = await attending("Frank Bia");
    const { attending: otherCol } = await attending("Jane Roe");
    await assign(mine.id, dayA.id, morning.id);
    await assign(sameCol.id, dayB.id, morning.id);
    // Same date-space, different column: not a qualification-preserving trade.
    await assign(otherCol.id, dayB.id, rhd.id);

    const partners = await eligibleAttendingSwapPartners(personId, dayA.id, morning.id);
    expect(partners.map((p) => p.name)).toEqual(["Frank Bia"]);
  });

  it("excludes a date the requester already covers in that column", async () => {
    const term = await activeTerm(FUTURE);
    const morning = await slot("9am-12pm", 0, true);
    const dayA = await clinicDay(term.id, FUTURE[0]);
    const dayB = await clinicDay(term.id, FUTURE[1]);
    const { attending: mine, personId } = await attending("Peggy Bia", { withPerson: true });
    const { attending: other } = await attending("Frank Bia");
    await assign(mine.id, dayA.id, morning.id);
    await assign(mine.id, dayB.id, morning.id);
    await assign(other.id, dayB.id, morning.id);

    expect(await eligibleAttendingSwapPartners(personId, dayA.id, morning.id)).toEqual([]);
  });

  it("excludes closed dates, past dates, and deactivated attendings", async () => {
    const term = await activeTerm([...PAST, ...FUTURE]);
    const morning = await slot("9am-12pm", 0);
    const mineDay = await clinicDay(term.id, FUTURE[0]);
    const closedDay = await clinicDay(term.id, FUTURE[1], { isClosed: true });
    const pastDay = await clinicDay(term.id, PAST[0]);
    const okDay = await clinicDay(term.id, FUTURE[2]);
    const { attending: mine, personId } = await attending("Peggy Bia", { withPerson: true });
    const { attending: onClosed } = await attending("Closed Doc");
    const { attending: onPast } = await attending("Past Doc");
    const { attending: retired } = await attending("Retired Doc", { isActive: false });
    await assign(mine.id, mineDay.id, morning.id);
    await assign(onClosed.id, closedDay.id, morning.id);
    await assign(onPast.id, pastDay.id, morning.id);
    await assign(retired.id, okDay.id, morning.id);

    expect(await eligibleAttendingSwapPartners(personId, mineDay.id, morning.id)).toEqual([]);
  });

  /**
   * Two requests against one seat would both validate and both apply. The seat is
   * withdrawn from the pool while a request names it, on either side.
   */
  it("excludes a seat already named by a pending request", async () => {
    const term = await activeTerm(FUTURE);
    const morning = await slot("9am-12pm", 0);
    const dayA = await clinicDay(term.id, FUTURE[0]);
    const dayB = await clinicDay(term.id, FUTURE[1]);
    const { attending: mine, personId } = await attending("Peggy Bia", { withPerson: true });
    const { attending: other } = await attending("Frank Bia");
    await assign(mine.id, dayA.id, morning.id);
    await assign(other.id, dayB.id, morning.id);

    // Frank has already asked to drop that seat.
    await prisma.attendingShiftRequest.create({
      data: { termId: term.id, requesterId: other.id, requesterDayId: dayB.id, requesterSlotId: morning.id },
    });

    expect(await eligibleAttendingSwapPartners(personId, dayA.id, morning.id)).toEqual([]);
  });
});

describe("createAttendingRequest", () => {
  async function twoDates() {
    const term = await activeTerm(FUTURE);
    const morning = await slot("9am-12pm", 0);
    const dayA = await clinicDay(term.id, FUTURE[0]);
    const dayB = await clinicDay(term.id, FUTURE[1]);
    const { attending: mine, personId } = await attending("Peggy Bia", { withPerson: true });
    const { attending: other } = await attending("Frank Bia");
    await assign(mine.id, dayA.id, morning.id);
    await assign(other.id, dayB.id, morning.id);
    return { term, morning, dayA, dayB, mine, other, personId };
  }

  it("records a drop and leaves the schedule untouched", async () => {
    const { morning, dayA, personId } = await twoDates();
    const { id } = await createAttendingRequest(personId, { clinicDayId: dayA.id, slotId: morning.id });

    const row = await prisma.attendingShiftRequest.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe("PENDING");
    expect(row.targetId).toBeNull();
    // The point of a request: nothing moves until it is approved.
    expect(await prisma.clinicDayAttending.count()).toBe(2);
  });

  it("records a named swap", async () => {
    const { morning, dayA, dayB, other, personId } = await twoDates();
    const { id } = await createAttendingRequest(personId, {
      clinicDayId: dayA.id,
      slotId: morning.id,
      target: { attendingId: other.id, clinicDayId: dayB.id, slotId: morning.id },
    });
    const row = await prisma.attendingShiftRequest.findUniqueOrThrow({ where: { id } });
    expect(row.targetId).toBe(other.id);
    expect(row.targetDayId).toBe(dayB.id);
  });

  /**
   * The posted slot is never trusted: it is re-checked against the grid, so a
   * stale tab or a crafted form cannot raise a request on someone else's seat.
   */
  it("refuses a slot the caller does not actually hold", async () => {
    const { morning, dayB, personId } = await twoDates();
    await expect(
      createAttendingRequest(personId, { clinicDayId: dayB.id, slotId: morning.id }),
    ).rejects.toThrow(/not scheduled/i);
  });

  it("refuses a cross-column swap", async () => {
    const { morning, dayA, dayB, other, personId, term } = await twoDates();
    const rhd = await slot("RHD Attending", 1);
    await assign(other.id, dayB.id, rhd.id);
    void term;
    await expect(
      createAttendingRequest(personId, {
        clinicDayId: dayA.id,
        slotId: morning.id,
        target: { attendingId: other.id, clinicDayId: dayB.id, slotId: rhd.id },
      }),
    ).rejects.toThrow(/same schedule column/i);
  });

  it("refuses a swap that would double-book either side", async () => {
    const { morning, dayA, dayB, mine, other, personId } = await twoDates();
    // The requester already covers the partner's date in this column.
    await assign(mine.id, dayB.id, morning.id);
    void other;
    await expect(
      createAttendingRequest(personId, {
        clinicDayId: dayA.id,
        slotId: morning.id,
        target: { attendingId: other.id, clinicDayId: dayB.id, slotId: morning.id },
      }),
    ).rejects.toThrow(/double-book/i);
  });

  it("refuses a second pending request for the same seat", async () => {
    const { morning, dayA, personId } = await twoDates();
    await createAttendingRequest(personId, { clinicDayId: dayA.id, slotId: morning.id });
    await expect(
      createAttendingRequest(personId, { clinicDayId: dayA.id, slotId: morning.id }),
    ).rejects.toThrow(/already have a pending request/i);
  });

  it("refuses a date that has already passed", async () => {
    const term = await activeTerm(PAST);
    const morning = await slot("9am-12pm", 0);
    const day = await clinicDay(term.id, PAST[0]);
    const { attending: mine, personId } = await attending("Peggy Bia", { withPerson: true });
    await assign(mine.id, day.id, morning.id);
    await expect(
      createAttendingRequest(personId, { clinicDayId: day.id, slotId: morning.id }),
    ).rejects.toThrow(/already passed/i);
  });

  it("refuses a closed clinic day", async () => {
    const term = await activeTerm(FUTURE);
    const morning = await slot("9am-12pm", 0);
    const day = await clinicDay(term.id, FUTURE[0], { isClosed: true });
    const { attending: mine, personId } = await attending("Peggy Bia", { withPerson: true });
    await assign(mine.id, day.id, morning.id);
    await expect(
      createAttendingRequest(personId, { clinicDayId: day.id, slotId: morning.id }),
    ).rejects.toThrow(/closed/i);
  });
});

describe("cancelAttendingRequest", () => {
  it("lets the requester withdraw their own, and nobody else's", async () => {
    const term = await activeTerm(FUTURE);
    const morning = await slot("9am-12pm", 0);
    const day = await clinicDay(term.id, FUTURE[0]);
    const { attending: mine, personId } = await attending("Peggy Bia", { withPerson: true });
    const { personId: strangerPid } = await attending("Frank Bia", { withPerson: true });
    await assign(mine.id, day.id, morning.id);
    const { id } = await createAttendingRequest(personId, { clinicDayId: day.id, slotId: morning.id });

    await expect(cancelAttendingRequest(strangerPid, id)).rejects.toThrow(AttendingPortalForbiddenError);

    await cancelAttendingRequest(personId, id);
    expect((await prisma.attendingShiftRequest.findUniqueOrThrow({ where: { id } })).status).toBe("CANCELLED");
  });
});

describe("approve / deny", () => {
  async function pendingSwap() {
    const term = await activeTerm(FUTURE);
    const morning = await slot("9am-12pm", 0);
    const dayA = await clinicDay(term.id, FUTURE[0]);
    const dayB = await clinicDay(term.id, FUTURE[1]);
    const { attending: mine, personId } = await attending("Peggy Bia", { withPerson: true });
    const { attending: other } = await attending("Frank Bia", { withPerson: true });
    await assign(mine.id, dayA.id, morning.id);
    await assign(other.id, dayB.id, morning.id);
    const { id } = await createAttendingRequest(personId, {
      clinicDayId: dayA.id,
      slotId: morning.id,
      target: { attendingId: other.id, clinicDayId: dayB.id, slotId: morning.id },
    });
    await grantManageAttendings();
    return { term, morning, dayA, dayB, mine, other, personId, id };
  }

  it("exchanges the two assignments on approval", async () => {
    const { dayA, dayB, mine, other, id } = await pendingSwap();
    await approveAttendingRequest(FCRL, id);

    const rows = await prisma.clinicDayAttending.findMany({ select: { attendingId: true, clinicDayId: true } });
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.attendingId === mine.id)!.clinicDayId).toBe(dayB.id);
    expect(rows.find((r) => r.attendingId === other.id)!.clinicDayId).toBe(dayA.id);
    expect((await prisma.attendingShiftRequest.findUniqueOrThrow({ where: { id } })).status).toBe("APPROVED");
  });

  it("deletes the assignment on an approved drop, leaving the column short", async () => {
    const term = await activeTerm(FUTURE);
    const morning = await slot("9am-12pm", 0);
    const day = await clinicDay(term.id, FUTURE[0]);
    const { attending: mine, personId } = await attending("Peggy Bia", { withPerson: true });
    await assign(mine.id, day.id, morning.id);
    const { id } = await createAttendingRequest(personId, { clinicDayId: day.id, slotId: morning.id });
    await grantManageAttendings();

    await approveAttendingRequest(FCRL, id);
    expect(await prisma.clinicDayAttending.count()).toBe(0);
  });

  it("refuses a caller without schedule.manage_attendings", async () => {
    const { id, personId } = await pendingSwap();
    // The requester is an attending, not an approver.
    await expect(approveAttendingRequest(personId, id)).rejects.toThrow(AttendingPortalForbiddenError);
  });

  /**
   * The grid is edited by hand between a request being raised and being decided.
   * Approval replays nothing it has not re-verified.
   */
  it("refuses when the requester no longer holds the seat", async () => {
    const { id, mine, dayA, morning } = await pendingSwap();
    await prisma.clinicDayAttending.deleteMany({
      where: { attendingId: mine.id, clinicDayId: dayA.id, slotId: morning.id },
    });
    await expect(approveAttendingRequest(FCRL, id)).rejects.toThrow(/no longer covers/i);
  });

  it("refuses when a participant has been deactivated since the request", async () => {
    const { id, other } = await pendingSwap();
    await prisma.attending.update({ where: { id: other.id }, data: { isActive: false } });
    await expect(approveAttendingRequest(FCRL, id)).rejects.toThrow(/no longer active/i);
  });

  it("refuses when the grid changed so the swap would now double-book", async () => {
    const { id, mine, dayB, morning } = await pendingSwap();
    // Faculty Relations booked the requester onto the partner's date in the
    // meantime, which is exactly the collision createAttendingRequest ruled out.
    await assign(mine.id, dayB.id, morning.id);
    await expect(approveAttendingRequest(FCRL, id)).rejects.toThrow(/double-book/i);
  });

  /**
   * Approving a stale drop would DELETE the record that this attending covered
   * that day, which by then is history rather than a schedule change. Deny stays
   * open, because it writes no grid row.
   */
  it("refuses to approve a date that has passed, but allows denying it", async () => {
    const term = await activeTerm(PAST);
    const morning = await slot("9am-12pm", 0);
    const day = await clinicDay(term.id, PAST[0]);
    const { attending: mine } = await attending("Peggy Bia", { withPerson: true });
    await assign(mine.id, day.id, morning.id);
    const req = await prisma.attendingShiftRequest.create({
      data: { termId: term.id, requesterId: mine.id, requesterDayId: day.id, requesterSlotId: morning.id },
    });
    await grantManageAttendings();

    await expect(approveAttendingRequest(FCRL, req.id)).rejects.toThrow(/already passed/i);
    await denyAttendingRequest(FCRL, req.id);
    expect((await prisma.attendingShiftRequest.findUniqueOrThrow({ where: { id: req.id } })).status).toBe("DENIED");
    // Denying a drop must not touch the schedule.
    expect(await prisma.clinicDayAttending.count()).toBe(1);
  });

  it("refuses to decide a request that is not pending", async () => {
    const { id } = await pendingSwap();
    await approveAttendingRequest(FCRL, id);
    await expect(denyAttendingRequest(FCRL, id)).rejects.toThrow(/pending/i);
  });
});

describe("listAttendingRequests / countPendingAttendingRequests", () => {
  it("is clinic-wide for an approver and refused for everyone else", async () => {
    const term = await activeTerm(FUTURE);
    const morning = await slot("9am-12pm", 0);
    const day = await clinicDay(term.id, FUTURE[0]);
    const { attending: mine, personId } = await attending("Peggy Bia", { withPerson: true });
    await assign(mine.id, day.id, morning.id);
    await createAttendingRequest(personId, { clinicDayId: day.id, slotId: morning.id, note: "Conference" });
    await grantManageAttendings();

    const rows = await listAttendingRequests(FCRL);
    expect(rows).toHaveLength(1);
    expect(rows[0].isSwap).toBe(false);
    expect(rows[0].requester.name).toBe("Peggy Bia");
    expect(rows[0].note).toBe("Conference");
    expect(rows[0].requesterSlotLabel).toBe("9am-12pm");

    expect(await countPendingAttendingRequests(FCRL)).toBe(1);
    // An attending is not an approver, even of their own request.
    await expect(listAttendingRequests(personId)).rejects.toThrow(AttendingPortalForbiddenError);
    expect(await countPendingAttendingRequests(personId)).toBe(0);
  });
});
