/**
 * Integration tests for the shift request service.
 *
 * Scoping model: createRequest/cancelRequest are requester-only operations.
 * list/approve/deny require the actor to be a director of the department (or
 * a delegated manager, or to hold schedule.edit_all).
 *
 * Fixtures: term with noon-UTC clinicDates (Saturdays), departments, persons,
 * and ShiftAssignment rows created directly via Prisma.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import {
  createRequest,
  cancelRequest,
  listDepartmentRequests,
  approveRequest,
  denyRequest,
  eligibleSwapPartners,
  remindDirectors,
  requestApproverRecipients,
  countPendingApprovals,
  RequestForbiddenError,
  RequestNotFoundError,
  RequestValidationError,
} from "./requests";
import { isoDateKey } from "@/platform/dates";
import { publishSchedule } from "./publication";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function utcNoon(year: number, month: number, day: number): Date {
  return new Date(Date.UTC(year, month - 1, day, 12, 0, 0, 0));
}

/**
 * Six consecutive Saturdays, anchored at noon UTC, starting comfortably in
 * the future relative to whenever the suite runs. requests.ts now refuses
 * change requests for clinic dates that have passed, so a base pinned to a
 * fixed calendar date would eventually fall into the past and break every
 * fixture below that isn't about that guard. Deriving the base from the real
 * clock, well clear of "today", keeps those ordinary fixtures valid
 * indefinitely. The tests that exercise the past/today/future boundary
 * itself inject an explicit `now` -- one of these same six dates -- instead
 * of relying on the real clock, so they stay deterministic regardless of
 * when this base lands.
 */
function sixSaturdays(): Date[] {
  const base = new Date();
  base.setUTCDate(base.getUTCDate() + 30); // comfortably clear of "today"
  const daysUntilSaturday = (6 - base.getUTCDay() + 7) % 7; // 6 = Saturday
  base.setUTCDate(base.getUTCDate() + daysUntilSaturday);
  const anchored = utcNoon(base.getUTCFullYear(), base.getUTCMonth() + 1, base.getUTCDate());
  return Array.from({ length: 6 }, (_, i) => new Date(anchored.getTime() + i * 7 * 86400000));
}

async function createPerson(name: string) {
  return prisma.person.create({ data: { name } });
}

async function createTerm(
  status: "ACTIVE" | "ARCHIVED" | "PLANNING" = "ACTIVE",
  clinicDates: Date[] = []
) {
  return prisma.term.create({
    data: {
      // Date.now() alone collides when two terms are created in the same
      // millisecond (several tests create a live and a next term back to back),
      // tripping the Term.code unique constraint. Matches builder.test.ts.
      code: `SU26-${Date.now()}-${Math.random()}`,
      name: "Summer 2026",
      startDate: new Date("2026-05-30T12:00:00Z"),
      endDate: new Date("2026-09-26T12:00:00Z"),
      status,
      clinicDates,
    },
  });
}

async function createDepartment(code: string) {
  return prisma.department.upsert({
    where: { code },
    update: {},
    create: { code, name: `${code} Dept` },
  });
}

async function createMembership(
  personId: string,
  termId: string,
  departmentId: string,
  kind: "VOLUNTEER" | "DIRECTOR",
  status: "ACTIVE" | "REMOVED" = "ACTIVE"
) {
  return prisma.termMembership.create({
    data: { personId, termId, departmentId, kind, status },
  });
}

async function createShift(
  termId: string,
  departmentId: string,
  personId: string,
  clinicDate: Date,
  role: "DIRECTOR" | "VOLUNTEER" | "SHADOW"
) {
  return prisma.shiftAssignment.create({
    data: {
      termId,
      departmentId,
      personId,
      clinicDate,
      role,
      triage: false,
      walkin: false,
      cc: false,
      remote: false,
    },
  });
}

async function grantPermission(personId: string, permission: string) {
  const role = await prisma.role.create({
    data: {
      name: `Role-${permission}-${Date.now()}-${Math.random()}`,
      isSystem: false,
      grants: { create: [{ permission }] },
    },
  });
  await prisma.roleAssignment.create({ data: { roleId: role.id, personId, termId: null } });
}

/**
 * Grants a permission to everyone holding a membership of `kind` in `termId` --
 * the "All Directors" / "All Volunteers" baseline assignment shape.
 */
async function grantPermissionToKind(
  kind: "VOLUNTEER" | "DIRECTOR",
  permission: string,
  termId: string,
) {
  const role = await prisma.role.create({
    data: {
      name: `Role-${kind}-${permission}-${Date.now()}-${Math.random()}`,
      isSystem: false,
      grants: { create: [{ permission }] },
    },
  });
  await prisma.roleAssignment.create({ data: { roleId: role.id, kind, termId } });
}

async function delegate(managerDepartmentId: string, managedDepartmentId: string) {
  return prisma.departmentDelegation.create({
    data: { managerDepartmentId, managedDepartmentId },
  });
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(resetDb);

describe("createRequest", () => {
  it("drop request: creates a PENDING ShiftRequest and writes an audit row", async () => {
    const dates = sixSaturdays();
    const term = await createTerm("ACTIVE", dates);
    const dept = await createDepartment("AABB");
    const actor = await createPerson("Alice");

    await createMembership(actor.id, term.id, dept.id, "VOLUNTEER");
    await createShift(term.id, dept.id, actor.id, dates[0], "VOLUNTEER");

    const req = await createRequest(actor.id, {
      termId: term.id,
      requesterDateKey: isoDateKey(dates[0]),
      departmentId: dept.id,
    });

    expect(req.requesterId).toBe(actor.id);
    expect(req.status).toBe("PENDING");
    expect(req.targetId).toBeNull();
    expect(req.targetDate).toBeNull();
    expect(isoDateKey(req.requesterDate)).toBe(isoDateKey(dates[0]));

    const audit = await prisma.auditLog.findFirst({ where: { action: "schedule.request" } });
    expect(audit).not.toBeNull();
    expect(audit?.actorPersonId).toBe(actor.id);
    const after = audit?.after as Record<string, unknown>;
    expect(after.type).toBe("drop");
  });

  it("swap request: stores canonical targetDate and type=swap in audit", async () => {
    const dates = sixSaturdays();
    const term = await createTerm("ACTIVE", dates);
    const dept = await createDepartment("AABB");
    const actor = await createPerson("Alice");
    const target = await createPerson("Bob");

    await createMembership(actor.id, term.id, dept.id, "VOLUNTEER");
    await createShift(term.id, dept.id, actor.id, dates[0], "VOLUNTEER");
    await createShift(term.id, dept.id, target.id, dates[1], "VOLUNTEER");

    const req = await createRequest(actor.id, {
      termId: term.id,
      requesterDateKey: isoDateKey(dates[0]),
      departmentId: dept.id,
      targetId: target.id,
      targetDateKey: isoDateKey(dates[1]),
    });

    expect(req.targetId).toBe(target.id);
    expect(req.targetDate).not.toBeNull();
    expect(isoDateKey(req.targetDate!)).toBe(isoDateKey(dates[1]));

    const audit = await prisma.auditLog.findFirst({ where: { action: "schedule.request" } });
    const after = audit?.after as Record<string, unknown>;
    expect(after.type).toBe("swap");
    expect(after.targetId).toBe(target.id);
  });

  it("rejects when actor has no assignment on that date", async () => {
    const dates = sixSaturdays();
    const term = await createTerm("ACTIVE", dates);
    const dept = await createDepartment("AABB");
    const actor = await createPerson("Alice");
    await createMembership(actor.id, term.id, dept.id, "VOLUNTEER");
    // No shift created

    await expect(
      createRequest(actor.id, {
        termId: term.id,
        requesterDateKey: isoDateKey(dates[0]),
        departmentId: dept.id,
      })
    ).rejects.toBeInstanceOf(RequestValidationError);
  });

  it("rejects when requesterDateKey is not a clinic date", async () => {
    const dates = sixSaturdays();
    const term = await createTerm("ACTIVE", dates);
    const dept = await createDepartment("AABB");
    const actor = await createPerson("Alice");
    await createMembership(actor.id, term.id, dept.id, "VOLUNTEER");

    await expect(
      createRequest(actor.id, {
        termId: term.id,
        requesterDateKey: "2000-01-01",
        departmentId: dept.id,
      })
    ).rejects.toBeInstanceOf(RequestValidationError);
  });

  it("rejects shadow swap with engine message", async () => {
    const dates = sixSaturdays();
    const term = await createTerm("ACTIVE", dates);
    const dept = await createDepartment("AABB");
    const actor = await createPerson("Shadow");
    const target = await createPerson("Other");

    await createMembership(actor.id, term.id, dept.id, "VOLUNTEER");
    await createShift(term.id, dept.id, actor.id, dates[0], "SHADOW");
    await createShift(term.id, dept.id, target.id, dates[1], "VOLUNTEER");

    await expect(
      createRequest(actor.id, {
        termId: term.id,
        requesterDateKey: isoDateKey(dates[0]),
        departmentId: dept.id,
        targetId: target.id,
        targetDateKey: isoDateKey(dates[1]),
      })
    ).rejects.toBeInstanceOf(RequestValidationError);

    await expect(
      createRequest(actor.id, {
        termId: term.id,
        requesterDateKey: isoDateKey(dates[0]),
        departmentId: dept.id,
        targetId: target.id,
        targetDateKey: isoDateKey(dates[1]),
      })
    ).rejects.toThrow("Shadow shifts can only be dropped, not swapped");
  });

  it("duplicate PENDING request rejected", async () => {
    const dates = sixSaturdays();
    const term = await createTerm("ACTIVE", dates);
    const dept = await createDepartment("AABB");
    const actor = await createPerson("Alice");

    await createMembership(actor.id, term.id, dept.id, "VOLUNTEER");
    await createShift(term.id, dept.id, actor.id, dates[0], "VOLUNTEER");

    await createRequest(actor.id, {
      termId: term.id,
      requesterDateKey: isoDateKey(dates[0]),
      departmentId: dept.id,
    });

    await expect(
      createRequest(actor.id, {
        termId: term.id,
        requesterDateKey: isoDateKey(dates[0]),
        departmentId: dept.id,
      })
    ).rejects.toBeInstanceOf(RequestValidationError);

    await expect(
      createRequest(actor.id, {
        termId: term.id,
        requesterDateKey: isoDateKey(dates[0]),
        departmentId: dept.id,
      })
    ).rejects.toThrow("already have a pending request");
  });

  it("second request allowed after first is CANCELLED", async () => {
    const dates = sixSaturdays();
    const term = await createTerm("ACTIVE", dates);
    const dept = await createDepartment("AABB");
    const actor = await createPerson("Alice");

    await createMembership(actor.id, term.id, dept.id, "VOLUNTEER");
    await createShift(term.id, dept.id, actor.id, dates[0], "VOLUNTEER");

    const first = await createRequest(actor.id, {
      termId: term.id,
      requesterDateKey: isoDateKey(dates[0]),
      departmentId: dept.id,
    });

    await cancelRequest(actor.id, first.id);

    const second = await createRequest(actor.id, {
      termId: term.id,
      requesterDateKey: isoDateKey(dates[0]),
      departmentId: dept.id,
    });

    expect(second.status).toBe("PENDING");
  });

  it("swap where target is SHADOW on requester's date is rejected at creation", async () => {
    const dates = sixSaturdays();
    const term = await createTerm("ACTIVE", dates);
    const dept = await createDepartment("AABB");
    const requester = await createPerson("Requester");
    const target = await createPerson("Target");

    // Requester is a VOLUNTEER on dates[0]; target is a VOLUNTEER on dates[1]
    // but ALSO a SHADOW on dates[0] (the requester's offered date).
    await createMembership(requester.id, term.id, dept.id, "VOLUNTEER");
    await createShift(term.id, dept.id, requester.id, dates[0], "VOLUNTEER");
    await createShift(term.id, dept.id, target.id, dates[1], "VOLUNTEER");
    await createShift(term.id, dept.id, target.id, dates[0], "SHADOW");

    await expect(
      createRequest(requester.id, {
        termId: term.id,
        requesterDateKey: isoDateKey(dates[0]),
        departmentId: dept.id,
        targetId: target.id,
        targetDateKey: isoDateKey(dates[1]),
      })
    ).rejects.toBeInstanceOf(RequestValidationError);

    await expect(
      createRequest(requester.id, {
        termId: term.id,
        requesterDateKey: isoDateKey(dates[0]),
        departmentId: dept.id,
        targetId: target.id,
        targetDateKey: isoDateKey(dates[1]),
      })
    ).rejects.toThrow("Partner is not eligible");
  });

  it("rejects when the actor has no roster membership for the term", async () => {
    const term = await createTerm("ARCHIVED", []);
    const dept = await createDepartment("AABB");
    const actor = await createPerson("Alice");

    await expect(
      createRequest(actor.id, {
        termId: term.id,
        requesterDateKey: "2026-06-06",
        departmentId: dept.id,
      })
    ).rejects.toBeInstanceOf(RequestValidationError);
  });

  it("stamps req.termId with a PLANNING next term (not the active term) once published", async () => {
    const dates = sixSaturdays();
    const live = await createTerm("ACTIVE", dates);
    const next = await createTerm("PLANNING", dates);
    const dept = await createDepartment("AABB");

    const director = await createPerson("Director");
    const vol = await createPerson("Volunteer");

    // Director manages the department via an ACTIVE live-term directorship;
    // manageableScheduleDepartmentIds/manageableDepartmentIds resolve off
    // getActiveTerm(), which is `live`, so this is what makes them a publisher.
    await createMembership(director.id, live.id, dept.id, "DIRECTOR");

    // The volunteer's ONLY membership is an ACTIVE one in the next (PLANNING)
    // term, with a shift on a next-term clinic date, so a drop request
    // validates against `next`, not the live term.
    await createMembership(vol.id, next.id, dept.id, "VOLUNTEER");
    await createShift(next.id, dept.id, vol.id, dates[0], "VOLUNTEER");

    await publishSchedule(director.id, { termId: next.id, departmentId: dept.id });

    const req = await createRequest(vol.id, {
      termId: next.id,
      requesterDateKey: isoDateKey(dates[0]),
      departmentId: dept.id,
    });

    // If createRequest reverted to stamping req.termId from getActiveTerm()
    // instead of the passed input.termId, this would be `live.id` since `live`
    // is the active term.
    expect(req.termId).toBe(next.id);
  });

  it("rejects a PLANNING next-term request when the department's schedule is not published", async () => {
    const dates = sixSaturdays();
    const live = await createTerm("ACTIVE", dates);
    const next = await createTerm("PLANNING", dates);
    const dept = await createDepartment("AABB");

    const director = await createPerson("Director");
    const vol = await createPerson("Volunteer");

    await createMembership(director.id, live.id, dept.id, "DIRECTOR");
    await createMembership(vol.id, next.id, dept.id, "VOLUNTEER");
    await createShift(next.id, dept.id, vol.id, dates[0], "VOLUNTEER");

    // Deliberately NOT published for the next term. Every other fact about the
    // request is otherwise valid (roster membership, shift on a real clinic
    // date), isolating the publish re-check as the sole reason this must
    // reject.
    await expect(
      createRequest(vol.id, {
        termId: next.id,
        requesterDateKey: isoDateKey(dates[0]),
        departmentId: dept.id,
      })
    ).rejects.toBeInstanceOf(RequestValidationError);
  });

  it("throws RequestValidationError for a past requesterDateKey", async () => {
    const dates = sixSaturdays();
    const term = await createTerm("ACTIVE", dates);
    const dept = await createDepartment("AABB");
    const actor = await createPerson("Alice");

    await createMembership(actor.id, term.id, dept.id, "VOLUNTEER");
    await createShift(term.id, dept.id, actor.id, dates[0], "VOLUNTEER");

    // "Now" is a week after dates[0]: that clinic day has already happened.
    await expect(
      createRequest(
        actor.id,
        { termId: term.id, requesterDateKey: isoDateKey(dates[0]), departmentId: dept.id },
        dates[1],
      )
    ).rejects.toThrow(RequestValidationError);
    await expect(
      createRequest(
        actor.id,
        { termId: term.id, requesterDateKey: isoDateKey(dates[0]), departmentId: dept.id },
        dates[1],
      )
    ).rejects.toThrow("That clinic date has already passed.");
  });

  it("throws RequestValidationError for a past targetDateKey", async () => {
    const dates = sixSaturdays();
    const term = await createTerm("ACTIVE", dates);
    const dept = await createDepartment("AABB");
    const actor = await createPerson("Alice");
    const target = await createPerson("Bob");

    await createMembership(actor.id, term.id, dept.id, "VOLUNTEER");
    await createMembership(target.id, term.id, dept.id, "VOLUNTEER");
    // Requester's own date (dates[1]) stays valid; the partner's date
    // (dates[0]) is the one that has passed by "now" = dates[1].
    await createShift(term.id, dept.id, actor.id, dates[1], "VOLUNTEER");
    await createShift(term.id, dept.id, target.id, dates[0], "VOLUNTEER");

    await expect(
      createRequest(
        actor.id,
        {
          termId: term.id,
          requesterDateKey: isoDateKey(dates[1]),
          departmentId: dept.id,
          targetId: target.id,
          targetDateKey: isoDateKey(dates[0]),
        },
        dates[1],
      )
    ).rejects.toThrow("That clinic date has already passed.");
  });

  it("still accepts a valid future pair (today counts as valid, the >= boundary)", async () => {
    const dates = sixSaturdays();
    const term = await createTerm("ACTIVE", dates);
    const dept = await createDepartment("AABB");
    const actor = await createPerson("Alice");

    await createMembership(actor.id, term.id, dept.id, "VOLUNTEER");
    await createShift(term.id, dept.id, actor.id, dates[0], "VOLUNTEER");

    // "Now" is exactly dates[0]: a same-day request against the morning of
    // the clinic day must still be accepted.
    const req = await createRequest(
      actor.id,
      { termId: term.id, requesterDateKey: isoDateKey(dates[0]), departmentId: dept.id },
      dates[0],
    );

    expect(req.status).toBe("PENDING");
  });
});

describe("cancelRequest", () => {
  it("requester can cancel their own PENDING request", async () => {
    const dates = sixSaturdays();
    const term = await createTerm("ACTIVE", dates);
    const dept = await createDepartment("AABB");
    const actor = await createPerson("Alice");

    await createMembership(actor.id, term.id, dept.id, "VOLUNTEER");
    await createShift(term.id, dept.id, actor.id, dates[0], "VOLUNTEER");
    const req = await createRequest(actor.id, {
      termId: term.id,
      requesterDateKey: isoDateKey(dates[0]),
      departmentId: dept.id,
    });

    await cancelRequest(actor.id, req.id);

    const updated = await prisma.shiftRequest.findUniqueOrThrow({ where: { id: req.id } });
    expect(updated.status).toBe("CANCELLED");

    const audit = await prisma.auditLog.findFirst({ where: { action: "schedule.request_cancel" } });
    expect(audit).not.toBeNull();
  });

  it("another person cannot cancel the request (Forbidden)", async () => {
    const dates = sixSaturdays();
    const term = await createTerm("ACTIVE", dates);
    const dept = await createDepartment("AABB");
    const actor = await createPerson("Alice");
    const other = await createPerson("Bob");

    await createMembership(actor.id, term.id, dept.id, "VOLUNTEER");
    await createShift(term.id, dept.id, actor.id, dates[0], "VOLUNTEER");
    const req = await createRequest(actor.id, {
      termId: term.id,
      requesterDateKey: isoDateKey(dates[0]),
      departmentId: dept.id,
    });

    await expect(cancelRequest(other.id, req.id)).rejects.toBeInstanceOf(RequestForbiddenError);
  });

  it("cannot cancel a non-PENDING request", async () => {
    const dates = sixSaturdays();
    const term = await createTerm("ACTIVE", dates);
    const dept = await createDepartment("AABB");
    const actor = await createPerson("Alice");
    const director = await createPerson("Director");

    await createMembership(director.id, term.id, dept.id, "DIRECTOR");
    await createMembership(actor.id, term.id, dept.id, "VOLUNTEER");
    await createShift(term.id, dept.id, actor.id, dates[0], "VOLUNTEER");

    const req = await createRequest(actor.id, {
      termId: term.id,
      requesterDateKey: isoDateKey(dates[0]),
      departmentId: dept.id,
    });

    // Deny it so it's no longer PENDING
    await denyRequest(director.id, req.id);

    await expect(cancelRequest(actor.id, req.id)).rejects.toBeInstanceOf(RequestValidationError);
    await expect(cancelRequest(actor.id, req.id)).rejects.toThrow("Only pending requests can be cancelled");
  });

  it("throws RequestNotFoundError for unknown id", async () => {
    const actor = await createPerson("Alice");
    await expect(cancelRequest(actor.id, "nonexistent-id")).rejects.toBeInstanceOf(RequestNotFoundError);
  });
});

describe("listDepartmentRequests", () => {
  it("returns PENDING first (createdAt asc) then decided (most recent first, max 10)", async () => {
    const dates = sixSaturdays();
    const term = await createTerm("ACTIVE", dates);
    const dept = await createDepartment("AABB");
    const director = await createPerson("Director");
    const vol1 = await createPerson("Vol1");
    const vol2 = await createPerson("Vol2");
    const vol3 = await createPerson("Vol3");

    await createMembership(director.id, term.id, dept.id, "DIRECTOR");
    await createMembership(vol1.id, term.id, dept.id, "VOLUNTEER");
    await createMembership(vol2.id, term.id, dept.id, "VOLUNTEER");
    await createShift(term.id, dept.id, vol1.id, dates[0], "VOLUNTEER");
    await createShift(term.id, dept.id, vol2.id, dates[1], "VOLUNTEER");
    await createShift(term.id, dept.id, vol3.id, dates[2], "VOLUNTEER");
    await createShift(term.id, dept.id, director.id, dates[3], "DIRECTOR");

    // Create two pending requests
    const pending1 = await createRequest(vol1.id, { termId: term.id, requesterDateKey: isoDateKey(dates[0]), departmentId: dept.id });
    const pending2 = await createRequest(vol2.id, { termId: term.id, requesterDateKey: isoDateKey(dates[1]), departmentId: dept.id });

    // Deny one so it becomes decided
    await denyRequest(director.id, pending1.id);

    const rows = await listDepartmentRequests(director.id, dept.id, term.id);

    expect(rows.length).toBeGreaterThanOrEqual(2);
    // PENDING comes first
    expect(rows[0].request.status).toBe("PENDING");
    // The decided row follows
    const decidedRows = rows.filter((r) => r.request.status !== "PENDING");
    expect(decidedRows.length).toBeGreaterThanOrEqual(1);
    expect(decidedRows[0].request.status).toBe("DENIED");

    // pending2 is still pending
    const pendingIds = rows.filter((r) => r.request.status === "PENDING").map((r) => r.request.id);
    expect(pendingIds).toContain(pending2.id);
  });

  it("keeps recent decisions visible: cancelled rows sort by recency, not always first", async () => {
    const dates = sixSaturdays();
    const term = await createTerm("ACTIVE", dates);
    const dept = await createDepartment("AABB");
    const director = await createPerson("Director");
    await createMembership(director.id, term.id, dept.id, "DIRECTOR");

    // 11 volunteers each create-and-cancel a drop on dates[0]. Cancellation
    // leaves decidedAt = null, and 11 exceeds the take:10 decided cap. Under the
    // old `decidedAt desc` ordering these null rows sorted NULLS FIRST (Postgres
    // default), filled the entire bucket, and hid every genuine decision.
    for (let i = 0; i < 11; i++) {
      const vol = await createPerson(`Canceller ${i}`);
      await createMembership(vol.id, term.id, dept.id, "VOLUNTEER");
      await createShift(term.id, dept.id, vol.id, dates[0], "VOLUNTEER");
      const req = await createRequest(vol.id, {
        termId: term.id,
        requesterDateKey: isoDateKey(dates[0]),
        departmentId: dept.id,
      });
      await cancelRequest(vol.id, req.id);
    }

    // A genuine denial happens last, so it is the most recent terminal event.
    const denied = await createPerson("Denied Vol");
    await createMembership(denied.id, term.id, dept.id, "VOLUNTEER");
    await createShift(term.id, dept.id, denied.id, dates[1], "VOLUNTEER");
    const deniedReq = await createRequest(denied.id, {
      termId: term.id,
      requesterDateKey: isoDateKey(dates[1]),
      departmentId: dept.id,
    });
    await denyRequest(director.id, deniedReq.id);

    const rows = await listDepartmentRequests(director.id, dept.id, term.id);
    const decidedRows = rows.filter((r) => r.request.status !== "PENDING");

    // The most recent real decision must survive the take:10 cap and rank first.
    expect(decidedRows.map((r) => r.request.id)).toContain(deniedReq.id);
    expect(decidedRows[0].request.id).toBe(deniedReq.id);
    expect(decidedRows[0].request.status).toBe("DENIED");
  });

  it("includes requester, target, and decidedBy names", async () => {
    const dates = sixSaturdays();
    const term = await createTerm("ACTIVE", dates);
    const dept = await createDepartment("AABB");
    const director = await createPerson("Director Dan");
    const requester = await createPerson("Requester Rae");
    const target = await createPerson("Target Tom");

    await createMembership(director.id, term.id, dept.id, "DIRECTOR");
    await createMembership(requester.id, term.id, dept.id, "VOLUNTEER");
    await createMembership(target.id, term.id, dept.id, "VOLUNTEER");
    await createShift(term.id, dept.id, requester.id, dates[0], "VOLUNTEER");
    await createShift(term.id, dept.id, target.id, dates[1], "VOLUNTEER");

    const req = await createRequest(requester.id, {
      termId: term.id,
      requesterDateKey: isoDateKey(dates[0]),
      departmentId: dept.id,
      targetId: target.id,
      targetDateKey: isoDateKey(dates[1]),
    });

    await approveRequest(director.id, req.id);

    const rows = await listDepartmentRequests(director.id, dept.id, term.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].requesterName).toBe("Requester Rae");
    expect(rows[0].targetName).toBe("Target Tom");
    expect(rows[0].decidedByName).toBe("Director Dan");
  });

  it("director of own dept can list (membership fixture)", async () => {
    const dates = sixSaturdays();
    const term = await createTerm("ACTIVE", dates);
    const dept = await createDepartment("AABB");
    const director = await createPerson("Director");

    await createMembership(director.id, term.id, dept.id, "DIRECTOR");

    const rows = await listDepartmentRequests(director.id, dept.id, term.id);
    expect(Array.isArray(rows)).toBe(true);
  });

  it("delegation edge: PCAR director can list SCTP requests", async () => {
    const dates = sixSaturdays();
    const term = await createTerm("ACTIVE", dates);
    const pcar = await createDepartment("PCAR");
    const sctp = await createDepartment("SCTP");
    await delegate(pcar.id, sctp.id);

    const director = await createPerson("PCAR Dir");
    await createMembership(director.id, term.id, pcar.id, "DIRECTOR");

    const rows = await listDepartmentRequests(director.id, sctp.id, term.id);
    expect(Array.isArray(rows)).toBe(true);
  });

  it("schedule.edit_all grant allows listing any department", async () => {
    const dates = sixSaturdays();
    const term = await createTerm("ACTIVE", dates);
    const dept = await createDepartment("AABB");
    const actor = await createPerson("Admin");

    await grantPermission(actor.id, "schedule.edit_all");

    const rows = await listDepartmentRequests(actor.id, dept.id, term.id);
    expect(Array.isArray(rows)).toBe(true);
  });

  it("outsider (no membership, no grant) gets RequestForbiddenError", async () => {
    const dates = sixSaturdays();
    const term = await createTerm("ACTIVE", dates);
    const dept = await createDepartment("AABB");
    const outsider = await createPerson("Outsider");

    await expect(listDepartmentRequests(outsider.id, dept.id, term.id)).rejects.toBeInstanceOf(
      RequestForbiddenError
    );
  });
});

// ---------------------------------------------------------------------------
// approveRequest
//
// Note on the deleteMany count guard (in requests.ts approveRequest):
// The guard throws when count !== 1 inside the transaction, rolling back all
// mutations so the request stays PENDING. There is no direct test for this path
// because validation outside the transaction catches all deterministic cases
// (e.g. "stale swap" test below deletes the assignment before approval, which
// the re-validation step catches first as "Not assigned"). The count guard
// exists solely as a race-window backstop for the gap between validation and
// the transaction; it is not deterministically testable without test hooks.
//
// Note on the swap collision guard:
// assertNoSwapCollision is called BOTH before the transaction (friendly early
// error) AND inside the transaction (using the tx client) as a race-window
// backstop. The "swap collision" tests below exercise the pre-tx path
// deterministically; the in-tx call is the enforcing point for any collision
// that appears between the outer check and the transaction acquiring its
// snapshot.
// ---------------------------------------------------------------------------

describe("approveRequest", () => {
  it("approving a drop request: removes the assignment, marks request APPROVED, writes audit", async () => {
    const dates = sixSaturdays();
    const term = await createTerm("ACTIVE", dates);
    const dept = await createDepartment("AABB");
    const director = await createPerson("Director");
    const vol = await createPerson("Volunteer");

    await createMembership(director.id, term.id, dept.id, "DIRECTOR");
    await createMembership(vol.id, term.id, dept.id, "VOLUNTEER");
    await createShift(term.id, dept.id, vol.id, dates[0], "VOLUNTEER");

    const req = await createRequest(vol.id, {
      termId: term.id,
      requesterDateKey: isoDateKey(dates[0]),
      departmentId: dept.id,
    });

    await approveRequest(director.id, req.id);

    const updated = await prisma.shiftRequest.findUniqueOrThrow({ where: { id: req.id } });
    expect(updated.status).toBe("APPROVED");
    expect(updated.decidedById).toBe(director.id);
    expect(updated.decidedAt).not.toBeNull();

    // Assignment removed
    const remaining = await prisma.shiftAssignment.findMany({
      where: { termId: term.id, departmentId: dept.id, personId: vol.id },
    });
    expect(remaining).toHaveLength(0);

    const audit = await prisma.auditLog.findFirst({ where: { action: "schedule.request_approve" } });
    expect(audit).not.toBeNull();
  });

  it("approving a swap: exchanges the two assignments (all four mutations landed)", async () => {
    const dates = sixSaturdays();
    const term = await createTerm("ACTIVE", dates);
    const dept = await createDepartment("AABB");
    const director = await createPerson("Director");
    const vol1 = await createPerson("Vol1");
    const vol2 = await createPerson("Vol2");

    await createMembership(director.id, term.id, dept.id, "DIRECTOR");
    await createMembership(vol1.id, term.id, dept.id, "VOLUNTEER");
    await createMembership(vol2.id, term.id, dept.id, "VOLUNTEER");
    await createShift(term.id, dept.id, vol1.id, dates[0], "VOLUNTEER");
    await createShift(term.id, dept.id, vol2.id, dates[1], "VOLUNTEER");

    const req = await createRequest(vol1.id, {
      termId: term.id,
      requesterDateKey: isoDateKey(dates[0]),
      departmentId: dept.id,
      targetId: vol2.id,
      targetDateKey: isoDateKey(dates[1]),
    });

    await approveRequest(director.id, req.id);

    // vol1 should now be on dates[1], vol2 on dates[0]
    const vol1Shifts = await prisma.shiftAssignment.findMany({
      where: { termId: term.id, departmentId: dept.id, personId: vol1.id },
    });
    const vol2Shifts = await prisma.shiftAssignment.findMany({
      where: { termId: term.id, departmentId: dept.id, personId: vol2.id },
    });

    expect(vol1Shifts).toHaveLength(1);
    expect(isoDateKey(vol1Shifts[0].clinicDate)).toBe(isoDateKey(dates[1]));

    expect(vol2Shifts).toHaveLength(1);
    expect(isoDateKey(vol2Shifts[0].clinicDate)).toBe(isoDateKey(dates[0]));
  });

  // The swap deletes both assignments and recreates them on the other's date, so
  // every tag has to be captured beforehand and replayed. Nothing tested that,
  // and the failure is quiet: the shift still moves and only the flag goes
  // missing, which nobody notices until a specialty clinic is short a med team.
  it("approving a swap carries the shift tags onto each person's new date", async () => {
    const dates = sixSaturdays();
    const term = await createTerm("ACTIVE", dates);
    const dept = await createDepartment("AABB");
    const director = await createPerson("Director");
    const vol1 = await createPerson("Vol1");
    const vol2 = await createPerson("Vol2");

    await createMembership(director.id, term.id, dept.id, "DIRECTOR");
    await createMembership(vol1.id, term.id, dept.id, "VOLUNTEER");
    await createMembership(vol2.id, term.id, dept.id, "VOLUNTEER");
    const a1 = await createShift(term.id, dept.id, vol1.id, dates[0], "VOLUNTEER");
    const a2 = await createShift(term.id, dept.id, vol2.id, dates[1], "VOLUNTEER");
    await prisma.shiftAssignment.update({ where: { id: a1.id }, data: { specialty: true, triage: true } });
    await prisma.shiftAssignment.update({ where: { id: a2.id }, data: { remote: true } });

    const req = await createRequest(vol1.id, {
      termId: term.id,
      requesterDateKey: isoDateKey(dates[0]),
      departmentId: dept.id,
      targetId: vol2.id,
      targetDateKey: isoDateKey(dates[1]),
    });

    await approveRequest(director.id, req.id);

    const moved1 = await prisma.shiftAssignment.findFirstOrThrow({
      where: { termId: term.id, departmentId: dept.id, personId: vol1.id },
    });
    const moved2 = await prisma.shiftAssignment.findFirstOrThrow({
      where: { termId: term.id, departmentId: dept.id, personId: vol2.id },
    });

    // Each person keeps their OWN tags on the date they moved to; the tags do
    // not swap with the dates.
    expect(isoDateKey(moved1.clinicDate)).toBe(isoDateKey(dates[1]));
    expect(moved1.specialty).toBe(true);
    expect(moved1.triage).toBe(true);
    expect(moved1.remote).toBe(false);

    expect(isoDateKey(moved2.clinicDate)).toBe(isoDateKey(dates[0]));
    expect(moved2.remote).toBe(true);
    expect(moved2.specialty).toBe(false);
  });

  it("rejects a swap onto a person no longer an active member of the department (audit #8/#25)", async () => {
    const dates = sixSaturdays();
    const term = await createTerm("ACTIVE", dates);
    const dept = await createDepartment("AABB");
    const director = await createPerson("Director");
    const vol1 = await createPerson("Vol1");
    const removed = await createPerson("Removed");

    await createMembership(director.id, term.id, dept.id, "DIRECTOR");
    await createMembership(vol1.id, term.id, dept.id, "VOLUNTEER");
    await createMembership(removed.id, term.id, dept.id, "VOLUNTEER"); // active when the request is made
    await createShift(term.id, dept.id, vol1.id, dates[0], "VOLUNTEER");
    await createShift(term.id, dept.id, removed.id, dates[1], "VOLUNTEER");

    const req = await createRequest(vol1.id, {
      termId: term.id,
      requesterDateKey: isoDateKey(dates[0]),
      departmentId: dept.id,
      targetId: removed.id,
      targetDateKey: isoDateKey(dates[1]),
    });

    // Then removed is taken off this department (single-dept offboard): membership
    // REMOVED, Person.status stays ACTIVE, and the future shift is left behind.
    await prisma.termMembership.updateMany({
      where: { personId: removed.id, termId: term.id, departmentId: dept.id },
      data: { status: "REMOVED" },
    });

    await expect(approveRequest(director.id, req.id)).rejects.toBeInstanceOf(RequestValidationError);
    const still = await prisma.shiftRequest.findUniqueOrThrow({ where: { id: req.id } });
    expect(still.status).toBe("PENDING");
  });

  it("stale swap (target's assignment deleted before approval): RequestValidationError, request still PENDING", async () => {
    const dates = sixSaturdays();
    const term = await createTerm("ACTIVE", dates);
    const dept = await createDepartment("AABB");
    const director = await createPerson("Director");
    const vol1 = await createPerson("Vol1");
    const vol2 = await createPerson("Vol2");

    await createMembership(director.id, term.id, dept.id, "DIRECTOR");
    await createMembership(vol1.id, term.id, dept.id, "VOLUNTEER");
    await createShift(term.id, dept.id, vol1.id, dates[0], "VOLUNTEER");
    const targetShift = await createShift(term.id, dept.id, vol2.id, dates[1], "VOLUNTEER");

    const req = await createRequest(vol1.id, {
      termId: term.id,
      requesterDateKey: isoDateKey(dates[0]),
      departmentId: dept.id,
      targetId: vol2.id,
      targetDateKey: isoDateKey(dates[1]),
    });

    // Remove target's assignment to make the swap stale
    await prisma.shiftAssignment.delete({ where: { id: targetShift.id } });

    await expect(approveRequest(director.id, req.id)).rejects.toBeInstanceOf(RequestValidationError);

    // Request remains PENDING
    const still = await prisma.shiftRequest.findUniqueOrThrow({ where: { id: req.id } });
    expect(still.status).toBe("PENDING");

    // vol1's assignment untouched
    const vol1Shifts = await prisma.shiftAssignment.findMany({
      where: { termId: term.id, departmentId: dept.id, personId: vol1.id },
    });
    expect(vol1Shifts).toHaveLength(1);
  });

  it("swap collision: target gains SHADOW on requester's date after creation -> RequestValidationError on approve, request stays PENDING, shadow row untouched", async () => {
    const dates = sixSaturdays();
    const term = await createTerm("ACTIVE", dates);
    const dept = await createDepartment("AABB");
    const director = await createPerson("Director");
    const vol1 = await createPerson("Vol1");
    const vol2 = await createPerson("Vol2");

    await createMembership(director.id, term.id, dept.id, "DIRECTOR");
    await createMembership(vol1.id, term.id, dept.id, "VOLUNTEER");
    await createShift(term.id, dept.id, vol1.id, dates[0], "VOLUNTEER");
    await createShift(term.id, dept.id, vol2.id, dates[1], "VOLUNTEER");

    // Create a valid swap request
    const req = await createRequest(vol1.id, {
      termId: term.id,
      requesterDateKey: isoDateKey(dates[0]),
      departmentId: dept.id,
      targetId: vol2.id,
      targetDateKey: isoDateKey(dates[1]),
    });

    // After creation, vol2 picks up a SHADOW assignment on dates[0] (vol1's date)
    const shadowRow = await createShift(term.id, dept.id, vol2.id, dates[0], "SHADOW");

    // Approve should fail due to the collision
    await expect(approveRequest(director.id, req.id)).rejects.toBeInstanceOf(RequestValidationError);
    await expect(approveRequest(director.id, req.id)).rejects.toThrow("Partner is not eligible");

    // Request remains PENDING
    const still = await prisma.shiftRequest.findUniqueOrThrow({ where: { id: req.id } });
    expect(still.status).toBe("PENDING");

    // vol1's original assignment is untouched
    const vol1Shifts = await prisma.shiftAssignment.findMany({
      where: { termId: term.id, departmentId: dept.id, personId: vol1.id },
    });
    expect(vol1Shifts).toHaveLength(1);
    expect(isoDateKey(vol1Shifts[0].clinicDate)).toBe(isoDateKey(dates[0]));
    expect(vol1Shifts[0].role).toBe("VOLUNTEER");

    // The shadow row that caused the collision is also untouched
    const shadowCheck = await prisma.shiftAssignment.findUnique({ where: { id: shadowRow.id } });
    expect(shadowCheck).not.toBeNull();
    expect(shadowCheck!.role).toBe("SHADOW");
  });

  it("swap collision (symmetric): requester gains SHADOW on target's date after creation -> RequestValidationError on approve, request stays PENDING", async () => {
    const dates = sixSaturdays();
    const term = await createTerm("ACTIVE", dates);
    const dept = await createDepartment("AABB");
    const director = await createPerson("Director");
    const vol1 = await createPerson("Vol1");
    const vol2 = await createPerson("Vol2");

    await createMembership(director.id, term.id, dept.id, "DIRECTOR");
    await createMembership(vol1.id, term.id, dept.id, "VOLUNTEER");
    await createShift(term.id, dept.id, vol1.id, dates[0], "VOLUNTEER");
    await createShift(term.id, dept.id, vol2.id, dates[1], "VOLUNTEER");

    // Create a valid swap request
    const req = await createRequest(vol1.id, {
      termId: term.id,
      requesterDateKey: isoDateKey(dates[0]),
      departmentId: dept.id,
      targetId: vol2.id,
      targetDateKey: isoDateKey(dates[1]),
    });

    // After creation, vol1 (the requester) picks up a SHADOW assignment on dates[1] (vol2's date)
    await createShift(term.id, dept.id, vol1.id, dates[1], "SHADOW");

    // Approve should fail due to the collision
    await expect(approveRequest(director.id, req.id)).rejects.toBeInstanceOf(RequestValidationError);
    await expect(approveRequest(director.id, req.id)).rejects.toThrow("Partner is not eligible");

    // Request remains PENDING
    const still = await prisma.shiftRequest.findUniqueOrThrow({ where: { id: req.id } });
    expect(still.status).toBe("PENDING");

    // vol2's original assignment is untouched
    const vol2Shifts = await prisma.shiftAssignment.findMany({
      where: { termId: term.id, departmentId: dept.id, personId: vol2.id },
    });
    expect(vol2Shifts).toHaveLength(1);
    expect(isoDateKey(vol2Shifts[0].clinicDate)).toBe(isoDateKey(dates[1]));
    expect(vol2Shifts[0].role).toBe("VOLUNTEER");
  });

  it("approving a non-PENDING request throws RequestValidationError", async () => {
    const dates = sixSaturdays();
    const term = await createTerm("ACTIVE", dates);
    const dept = await createDepartment("AABB");
    const director = await createPerson("Director");
    const vol = await createPerson("Volunteer");

    await createMembership(director.id, term.id, dept.id, "DIRECTOR");
    await createMembership(vol.id, term.id, dept.id, "VOLUNTEER");
    await createShift(term.id, dept.id, vol.id, dates[0], "VOLUNTEER");

    const req = await createRequest(vol.id, {
      termId: term.id,
      requesterDateKey: isoDateKey(dates[0]),
      departmentId: dept.id,
    });

    await denyRequest(director.id, req.id);

    await expect(approveRequest(director.id, req.id)).rejects.toBeInstanceOf(RequestValidationError);
  });

  it("refuses to swap an offboarded participant onto a shift, leaving the request PENDING (audit F5)", async () => {
    const dates = sixSaturdays();
    const term = await createTerm("ACTIVE", dates);
    const dept = await createDepartment("AABB");
    const director = await createPerson("Director");
    const vol1 = await createPerson("Vol1");
    const offboarded = await createPerson("Vol2");

    await createMembership(director.id, term.id, dept.id, "DIRECTOR");
    await createMembership(vol1.id, term.id, dept.id, "VOLUNTEER");
    await createShift(term.id, dept.id, vol1.id, dates[0], "VOLUNTEER");
    await createShift(term.id, dept.id, offboarded.id, dates[1], "VOLUNTEER");

    // The swap request is created while the target is still active.
    const req = await createRequest(vol1.id, {
      termId: term.id,
      requesterDateKey: isoDateKey(dates[0]),
      departmentId: dept.id,
      targetId: offboarded.id,
      targetDateKey: isoDateKey(dates[1]),
    });

    // Target is offboarded afterward; their leftover future shift remains.
    await prisma.person.update({ where: { id: offboarded.id }, data: { status: "OFFBOARDED" } });

    await expect(approveRequest(director.id, req.id)).rejects.toBeInstanceOf(RequestValidationError);

    // The offboarded person was NOT re-scheduled onto the requester's date, and the
    // whole transaction rolled back (request stays PENDING).
    const onRequesterDate = await prisma.shiftAssignment.findMany({
      where: { termId: term.id, departmentId: dept.id, personId: offboarded.id, clinicDate: dates[0] },
    });
    expect(onRequesterDate).toHaveLength(0);
    const reqAfter = await prisma.shiftRequest.findUniqueOrThrow({ where: { id: req.id } });
    expect(reqAfter.status).toBe("PENDING");
  });

  it("refuses a request whose requesterDate has passed, naming Deny as the alternative", async () => {
    const dates = sixSaturdays();
    const term = await createTerm("ACTIVE", dates);
    const dept = await createDepartment("AABB");
    const director = await createPerson("Director");
    const vol = await createPerson("Volunteer");

    await createMembership(director.id, term.id, dept.id, "DIRECTOR");
    await createMembership(vol.id, term.id, dept.id, "VOLUNTEER");
    await createShift(term.id, dept.id, vol.id, dates[0], "VOLUNTEER");

    // Created while dates[0] is still "today"; by the time a director acts on
    // it (a week later, dates[1]), dates[0] has passed.
    const req = await createRequest(
      vol.id,
      { termId: term.id, requesterDateKey: isoDateKey(dates[0]), departmentId: dept.id },
      dates[0],
    );

    await expect(approveRequest(director.id, req.id, dates[1])).rejects.toBeInstanceOf(
      RequestValidationError,
    );
    await expect(approveRequest(director.id, req.id, dates[1])).rejects.toThrow(
      "This request is for a clinic date that has already passed. Deny it instead.",
    );

    const still = await prisma.shiftRequest.findUniqueOrThrow({ where: { id: req.id } });
    expect(still.status).toBe("PENDING");
  });

  it("refuses a request whose targetDate has passed", async () => {
    const dates = sixSaturdays();
    const term = await createTerm("ACTIVE", dates);
    const dept = await createDepartment("AABB");
    const director = await createPerson("Director");
    const vol1 = await createPerson("Vol1");
    const vol2 = await createPerson("Vol2");

    await createMembership(director.id, term.id, dept.id, "DIRECTOR");
    await createMembership(vol1.id, term.id, dept.id, "VOLUNTEER");
    await createMembership(vol2.id, term.id, dept.id, "VOLUNTEER");
    // Requester's date (dates[1]) stays valid through approval; the partner's
    // date (dates[0]) is the one that has passed by the time approval runs.
    await createShift(term.id, dept.id, vol1.id, dates[1], "VOLUNTEER");
    await createShift(term.id, dept.id, vol2.id, dates[0], "VOLUNTEER");

    const req = await createRequest(
      vol1.id,
      {
        termId: term.id,
        requesterDateKey: isoDateKey(dates[1]),
        departmentId: dept.id,
        targetId: vol2.id,
        targetDateKey: isoDateKey(dates[0]),
      },
      dates[0],
    );

    await expect(approveRequest(director.id, req.id, dates[1])).rejects.toThrow(
      "This request is for a clinic date that has already passed. Deny it instead.",
    );

    const still = await prisma.shiftRequest.findUniqueOrThrow({ where: { id: req.id } });
    expect(still.status).toBe("PENDING");
  });

  it("still approves a valid one, including exactly on the clinic day (the >= boundary)", async () => {
    const dates = sixSaturdays();
    const term = await createTerm("ACTIVE", dates);
    const dept = await createDepartment("AABB");
    const director = await createPerson("Director");
    const vol = await createPerson("Volunteer");

    await createMembership(director.id, term.id, dept.id, "DIRECTOR");
    await createMembership(vol.id, term.id, dept.id, "VOLUNTEER");
    await createShift(term.id, dept.id, vol.id, dates[0], "VOLUNTEER");

    const req = await createRequest(
      vol.id,
      { termId: term.id, requesterDateKey: isoDateKey(dates[0]), departmentId: dept.id },
      dates[0],
    );

    // "Now" is exactly dates[0]: approving on the clinic day itself is valid.
    await approveRequest(director.id, req.id, dates[0]);

    const updated = await prisma.shiftRequest.findUniqueOrThrow({ where: { id: req.id } });
    expect(updated.status).toBe("APPROVED");
  });

  it("denying a stale request still works (the escape hatch once approve is refused)", async () => {
    const dates = sixSaturdays();
    const term = await createTerm("ACTIVE", dates);
    const dept = await createDepartment("AABB");
    const director = await createPerson("Director");
    const vol = await createPerson("Volunteer");

    await createMembership(director.id, term.id, dept.id, "DIRECTOR");
    await createMembership(vol.id, term.id, dept.id, "VOLUNTEER");
    await createShift(term.id, dept.id, vol.id, dates[0], "VOLUNTEER");

    const req = await createRequest(
      vol.id,
      { termId: term.id, requesterDateKey: isoDateKey(dates[0]), departmentId: dept.id },
      dates[0],
    );

    // The clinic date has since passed: approve is refused ...
    await expect(approveRequest(director.id, req.id, dates[1])).rejects.toBeInstanceOf(
      RequestValidationError,
    );

    // ... but deny -- the only disposition left for the director -- has no
    // date guard and still works.
    await denyRequest(director.id, req.id);

    const updated = await prisma.shiftRequest.findUniqueOrThrow({ where: { id: req.id } });
    expect(updated.status).toBe("DENIED");
    expect(updated.decidedById).toBe(director.id);
  });
});

describe("denyRequest", () => {
  it("sets status DENIED, appends note, records decidedBy/At", async () => {
    const dates = sixSaturdays();
    const term = await createTerm("ACTIVE", dates);
    const dept = await createDepartment("AABB");
    const director = await createPerson("Director");
    const vol = await createPerson("Volunteer");

    await createMembership(director.id, term.id, dept.id, "DIRECTOR");
    await createMembership(vol.id, term.id, dept.id, "VOLUNTEER");
    await createShift(term.id, dept.id, vol.id, dates[0], "VOLUNTEER");

    const req = await createRequest(vol.id, {
      termId: term.id,
      requesterDateKey: isoDateKey(dates[0]),
      departmentId: dept.id,
      note: "Original note",
    });

    await denyRequest(director.id, req.id, "Not enough time");

    const updated = await prisma.shiftRequest.findUniqueOrThrow({ where: { id: req.id } });
    expect(updated.status).toBe("DENIED");
    expect(updated.decidedById).toBe(director.id);
    expect(updated.decidedAt).not.toBeNull();
    expect(updated.note).toContain("Not enough time");
    expect(updated.note).toContain("Denied:");

    const audit = await prisma.auditLog.findFirst({ where: { action: "schedule.request_deny" } });
    expect(audit).not.toBeNull();
  });

  it("deny without note still sets DENIED status", async () => {
    const dates = sixSaturdays();
    const term = await createTerm("ACTIVE", dates);
    const dept = await createDepartment("AABB");
    const director = await createPerson("Director");
    const vol = await createPerson("Volunteer");

    await createMembership(director.id, term.id, dept.id, "DIRECTOR");
    await createMembership(vol.id, term.id, dept.id, "VOLUNTEER");
    await createShift(term.id, dept.id, vol.id, dates[0], "VOLUNTEER");

    const req = await createRequest(vol.id, {
      termId: term.id,
      requesterDateKey: isoDateKey(dates[0]),
      departmentId: dept.id,
    });

    await denyRequest(director.id, req.id);

    const updated = await prisma.shiftRequest.findUniqueOrThrow({ where: { id: req.id } });
    expect(updated.status).toBe("DENIED");
    expect(updated.note).toBeNull();
  });

  it("cannot deny a non-PENDING request", async () => {
    const dates = sixSaturdays();
    const term = await createTerm("ACTIVE", dates);
    const dept = await createDepartment("AABB");
    const director = await createPerson("Director");
    const vol = await createPerson("Volunteer");

    await createMembership(director.id, term.id, dept.id, "DIRECTOR");
    await createMembership(vol.id, term.id, dept.id, "VOLUNTEER");
    await createShift(term.id, dept.id, vol.id, dates[0], "VOLUNTEER");

    const req = await createRequest(vol.id, {
      termId: term.id,
      requesterDateKey: isoDateKey(dates[0]),
      departmentId: dept.id,
    });

    await approveRequest(director.id, req.id);

    await expect(denyRequest(director.id, req.id)).rejects.toBeInstanceOf(RequestValidationError);
  });
});

describe("eligibleSwapPartners", () => {
  it("returns same-role, same-dept volunteers on different dates, sorted by dateKey then name", async () => {
    const dates = sixSaturdays();
    const term = await createTerm("ACTIVE", dates);
    const dept = await createDepartment("AABB");
    const actor = await createPerson("Actor");
    const partner1 = await createPerson("Zara");
    const partner2 = await createPerson("Aaron");

    await createMembership(partner1.id, term.id, dept.id, "VOLUNTEER");
    await createMembership(partner2.id, term.id, dept.id, "VOLUNTEER");
    await createShift(term.id, dept.id, actor.id, dates[0], "VOLUNTEER");
    await createShift(term.id, dept.id, partner1.id, dates[1], "VOLUNTEER");
    await createShift(term.id, dept.id, partner2.id, dates[2], "VOLUNTEER");

    const partners = await eligibleSwapPartners(actor.id, isoDateKey(dates[0]), dept.id, term.id);

    expect(partners.length).toBe(2);
    // Both are eligible (different dates, same role)
    const names = partners.map((p) => p.name);
    expect(names).toContain("Zara");
    expect(names).toContain("Aaron");

    // Sorted by dateKey first (dates[1] < dates[2]) then name
    expect(partners[0].dateKey).toBe(isoDateKey(dates[1]));
    expect(partners[1].dateKey).toBe(isoDateKey(dates[2]));
  });

  it("excludes the actor themselves", async () => {
    const dates = sixSaturdays();
    const term = await createTerm("ACTIVE", dates);
    const dept = await createDepartment("AABB");
    const actor = await createPerson("Actor");

    await createShift(term.id, dept.id, actor.id, dates[0], "VOLUNTEER");
    // Actor also on another date (multi-shift)
    await createShift(term.id, dept.id, actor.id, dates[1], "VOLUNTEER");

    const partners = await eligibleSwapPartners(actor.id, isoDateKey(dates[0]), dept.id, term.id);

    const ids = partners.map((p) => p.personId);
    expect(ids).not.toContain(actor.id);
  });

  it("excludes persons in other departments", async () => {
    const dates = sixSaturdays();
    const term = await createTerm("ACTIVE", dates);
    const deptA = await createDepartment("AABB");
    const deptB = await createDepartment("BBCC");
    const actor = await createPerson("Actor");
    const otherDeptVol = await createPerson("OtherDept");

    await createShift(term.id, deptA.id, actor.id, dates[0], "VOLUNTEER");
    await createShift(term.id, deptB.id, otherDeptVol.id, dates[1], "VOLUNTEER");

    const partners = await eligibleSwapPartners(actor.id, isoDateKey(dates[0]), deptA.id, term.id);

    const ids = partners.map((p) => p.personId);
    expect(ids).not.toContain(otherDeptVol.id);
  });

  it("excludes persons on the same date as actor", async () => {
    const dates = sixSaturdays();
    const term = await createTerm("ACTIVE", dates);
    const dept = await createDepartment("AABB");
    const actor = await createPerson("Actor");
    const sameDate = await createPerson("SameDate");

    await createShift(term.id, dept.id, actor.id, dates[0], "VOLUNTEER");
    await createShift(term.id, dept.id, sameDate.id, dates[0], "VOLUNTEER");

    const partners = await eligibleSwapPartners(actor.id, isoDateKey(dates[0]), dept.id, term.id);

    const ids = partners.map((p) => p.personId);
    expect(ids).not.toContain(sameDate.id);
  });

  it("returns [] for shadow actors since shadows cannot swap", async () => {
    const dates = sixSaturdays();
    const term = await createTerm("ACTIVE", dates);
    const dept = await createDepartment("AABB");
    const actor = await createPerson("Shadow");
    const otherShadow = await createPerson("OtherShadow");

    await createShift(term.id, dept.id, actor.id, dates[0], "SHADOW");
    await createShift(term.id, dept.id, otherShadow.id, dates[1], "SHADOW");

    const partners = await eligibleSwapPartners(actor.id, isoDateKey(dates[0]), dept.id, term.id);

    expect(partners).toHaveLength(0);
  });

  it("does not mix roles: directors are not returned for a volunteer actor", async () => {
    const dates = sixSaturdays();
    const term = await createTerm("ACTIVE", dates);
    const dept = await createDepartment("AABB");
    const actor = await createPerson("Volunteer");
    const dir = await createPerson("Director");

    await createShift(term.id, dept.id, actor.id, dates[0], "VOLUNTEER");
    await createShift(term.id, dept.id, dir.id, dates[1], "DIRECTOR");

    const partners = await eligibleSwapPartners(actor.id, isoDateKey(dates[0]), dept.id, term.id);

    const ids = partners.map((p) => p.personId);
    expect(ids).not.toContain(dir.id);
  });

  it("excludes an offboarded person with a leftover future shift (audit F5)", async () => {
    const dates = sixSaturdays();
    const term = await createTerm("ACTIVE", dates);
    const dept = await createDepartment("AABB");
    const actor = await createPerson("Actor");
    const offboarded = await createPerson("Gone");

    await createShift(term.id, dept.id, actor.id, dates[0], "VOLUNTEER");
    await createShift(term.id, dept.id, offboarded.id, dates[1], "VOLUNTEER");
    // Offboarding flips Person.status but leaves the future ShiftAssignment behind.
    await prisma.person.update({ where: { id: offboarded.id }, data: { status: "OFFBOARDED" } });

    const partners = await eligibleSwapPartners(actor.id, isoDateKey(dates[0]), dept.id, term.id);
    expect(partners.map((p) => p.personId)).not.toContain(offboarded.id);
  });

  it("excludes a person removed from the department (REMOVED membership) though Person.status stays ACTIVE (audit #8/#25)", async () => {
    const dates = sixSaturdays();
    const term = await createTerm("ACTIVE", dates);
    const dept = await createDepartment("AABB");
    const actor = await createPerson("Actor");
    const removed = await createPerson("Removed");

    // A single-department removal sets TermMembership.status = REMOVED but leaves
    // Person.status ACTIVE and does not delete the leftover future shift.
    await createMembership(actor.id, term.id, dept.id, "VOLUNTEER");
    await createMembership(removed.id, term.id, dept.id, "VOLUNTEER", "REMOVED");
    await createShift(term.id, dept.id, actor.id, dates[0], "VOLUNTEER");
    await createShift(term.id, dept.id, removed.id, dates[1], "VOLUNTEER");

    const partners = await eligibleSwapPartners(actor.id, isoDateKey(dates[0]), dept.id, term.id);
    expect(partners.map((p) => p.personId)).not.toContain(removed.id);
  });

  // The dropdown must only offer swaps that createRequest/assertNoSwapCollision
  // will accept. The two cases below mirror that guard's two collision checks so
  // volunteers never pick a partner that always fails with "Partner is not eligible".

  it("excludes partners whose date the actor already works (would collide on the target's date)", async () => {
    const dates = sixSaturdays();
    const term = await createTerm("ACTIVE", dates);
    const dept = await createDepartment("AABB");
    const actor = await createPerson("Actor");
    const collidingPartner = await createPerson("Colliding");
    const cleanPartner = await createPerson("Clean");

    await createMembership(collidingPartner.id, term.id, dept.id, "VOLUNTEER");
    await createMembership(cleanPartner.id, term.id, dept.id, "VOLUNTEER");
    // Actor works dates[0] (the shift being requested) AND dates[1].
    await createShift(term.id, dept.id, actor.id, dates[0], "VOLUNTEER");
    await createShift(term.id, dept.id, actor.id, dates[1], "VOLUNTEER");
    // collidingPartner is on dates[1]; swapping onto it would collide because
    // the actor already holds an assignment there (requesterOnTargetDate).
    await createShift(term.id, dept.id, collidingPartner.id, dates[1], "VOLUNTEER");
    // cleanPartner is on dates[2], where the actor has no assignment.
    await createShift(term.id, dept.id, cleanPartner.id, dates[2], "VOLUNTEER");

    const partners = await eligibleSwapPartners(actor.id, isoDateKey(dates[0]), dept.id, term.id);

    const ids = partners.map((p) => p.personId);
    expect(ids).not.toContain(collidingPartner.id);
    expect(ids).toContain(cleanPartner.id);
  });

  it("excludes partners who also hold an assignment on the actor's requester date", async () => {
    const dates = sixSaturdays();
    const term = await createTerm("ACTIVE", dates);
    const dept = await createDepartment("AABB");
    const actor = await createPerson("Actor");
    const collidingPartner = await createPerson("Colliding");
    const cleanPartner = await createPerson("Clean");

    await createMembership(collidingPartner.id, term.id, dept.id, "VOLUNTEER");
    await createMembership(cleanPartner.id, term.id, dept.id, "VOLUNTEER");
    await createShift(term.id, dept.id, actor.id, dates[0], "VOLUNTEER");
    // collidingPartner offers dates[1] but ALSO holds a SHADOW row on dates[0],
    // the actor's requester date; assertNoSwapCollision rejects this
    // (targetOnRequesterDate), so it must not be offered.
    await createShift(term.id, dept.id, collidingPartner.id, dates[1], "VOLUNTEER");
    await createShift(term.id, dept.id, collidingPartner.id, dates[0], "SHADOW");
    // cleanPartner only works dates[2].
    await createShift(term.id, dept.id, cleanPartner.id, dates[2], "VOLUNTEER");

    const partners = await eligibleSwapPartners(actor.id, isoDateKey(dates[0]), dept.id, term.id);

    const ids = partners.map((p) => p.personId);
    expect(ids).not.toContain(collidingPartner.id);
    expect(ids).toContain(cleanPartner.id);
  });

  it("excludes a partner whose only free date is in the past", async () => {
    const dates = sixSaturdays();
    const term = await createTerm("ACTIVE", dates);
    const dept = await createDepartment("AABB");
    const actor = await createPerson("Actor");
    const partner = await createPerson("Partner");

    await createMembership(actor.id, term.id, dept.id, "VOLUNTEER");
    await createMembership(partner.id, term.id, dept.id, "VOLUNTEER");
    await createShift(term.id, dept.id, actor.id, dates[3], "VOLUNTEER");
    // Partner's only shift is dates[0], which has already passed by "now" =
    // dates[1].
    await createShift(term.id, dept.id, partner.id, dates[0], "VOLUNTEER");

    const partners = await eligibleSwapPartners(
      actor.id,
      isoDateKey(dates[3]),
      dept.id,
      term.id,
      dates[1],
    );

    expect(partners.map((p) => p.personId)).not.toContain(partner.id);
  });

  it("includes a partner whose only free date is today (the >= boundary)", async () => {
    const dates = sixSaturdays();
    const term = await createTerm("ACTIVE", dates);
    const dept = await createDepartment("AABB");
    const actor = await createPerson("Actor");
    const partner = await createPerson("Partner");

    await createMembership(actor.id, term.id, dept.id, "VOLUNTEER");
    await createMembership(partner.id, term.id, dept.id, "VOLUNTEER");
    await createShift(term.id, dept.id, actor.id, dates[3], "VOLUNTEER");
    // Partner's only shift is dates[1], which IS "now" -- today, not past.
    await createShift(term.id, dept.id, partner.id, dates[1], "VOLUNTEER");

    const partners = await eligibleSwapPartners(
      actor.id,
      isoDateKey(dates[3]),
      dept.id,
      term.id,
      dates[1],
    );

    expect(partners.map((p) => p.personId)).toContain(partner.id);
  });

  it("still includes a partner whose free date is in the future", async () => {
    const dates = sixSaturdays();
    const term = await createTerm("ACTIVE", dates);
    const dept = await createDepartment("AABB");
    const actor = await createPerson("Actor");
    const partner = await createPerson("Partner");

    await createMembership(actor.id, term.id, dept.id, "VOLUNTEER");
    await createMembership(partner.id, term.id, dept.id, "VOLUNTEER");
    await createShift(term.id, dept.id, actor.id, dates[3], "VOLUNTEER");
    // Partner's only shift is dates[4], after "now" = dates[1].
    await createShift(term.id, dept.id, partner.id, dates[4], "VOLUNTEER");

    const partners = await eligibleSwapPartners(
      actor.id,
      isoDateKey(dates[3]),
      dept.id,
      term.id,
      dates[1],
    );

    expect(partners.map((p) => p.personId)).toContain(partner.id);
  });
});

// ---------------------------------------------------------------------------
// manage_requests scope
// ---------------------------------------------------------------------------

describe("manage_requests scope", () => {
  it("lets a non-director with schedule.manage_requests list a member department's requests", async () => {
    const dates = sixSaturdays();
    const term = await createTerm("ACTIVE", dates);
    const dept = await createDepartment("MRQ1");
    const actor = await createPerson("ReqMgr");
    await createMembership(actor.id, term.id, dept.id, "VOLUNTEER");
    await grantPermission(actor.id, "schedule.manage_requests");

    // Should not throw (returns [] when there are no requests).
    await expect(listDepartmentRequests(actor.id, dept.id, term.id)).resolves.toEqual([]);
  });

  it("forbids a member without schedule.manage_requests", async () => {
    const dates = sixSaturdays();
    const term = await createTerm("ACTIVE", dates);
    const dept = await createDepartment("MRQ2");
    const actor = await createPerson("PlainMember");
    await createMembership(actor.id, term.id, dept.id, "VOLUNTEER");

    await expect(listDepartmentRequests(actor.id, dept.id, term.id)).rejects.toBeInstanceOf(RequestForbiddenError);
  });

  it("schedule.edit_own_dept alone does NOT grant request decisions", async () => {
    const dates = sixSaturdays();
    const term = await createTerm("ACTIVE", dates);
    const dept = await createDepartment("MRQ3");
    const actor = await createPerson("EditOnly");
    await createMembership(actor.id, term.id, dept.id, "VOLUNTEER");
    await grantPermission(actor.id, "schedule.edit_own_dept");

    await expect(listDepartmentRequests(actor.id, dept.id, term.id)).rejects.toBeInstanceOf(RequestForbiddenError);
  });

  it("does NOT reach a volunteer department when manage_requests came from a DIRECTOR assignment", async () => {
    // Directs one department, volunteers in another. The grant is assigned to
    // "All Directors", so it must not confer decisions in the volunteer one.
    const dates = sixSaturdays();
    const term = await createTerm("ACTIVE", dates);
    const directed = await createDepartment("MRQ4");
    const volunteered = await createDepartment("MRQ5");
    const actor = await createPerson("Director-and-Volunteer");
    await createMembership(actor.id, term.id, directed.id, "DIRECTOR");
    await createMembership(actor.id, term.id, volunteered.id, "VOLUNTEER");
    await grantPermissionToKind("DIRECTOR", "schedule.manage_requests", term.id);

    await expect(listDepartmentRequests(actor.id, directed.id, term.id)).resolves.toEqual([]);
    await expect(
      listDepartmentRequests(actor.id, volunteered.id, term.id),
    ).rejects.toBeInstanceOf(RequestForbiddenError);
  });

  it("reaches a volunteer department when manage_requests came from a VOLUNTEER assignment", async () => {
    const dates = sixSaturdays();
    const term = await createTerm("ACTIVE", dates);
    const dept = await createDepartment("MRQ6");
    const actor = await createPerson("Volunteer-Ops");
    await createMembership(actor.id, term.id, dept.id, "VOLUNTEER");
    await grantPermissionToKind("VOLUNTEER", "schedule.manage_requests", term.id);

    await expect(listDepartmentRequests(actor.id, dept.id, term.id)).resolves.toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Approver notifications (audit L1)
//
// createRequest must email the department's ACTUAL approvers -- the same set
// approveRequest routes through (directors by membership + one-hop delegated
// directors) -- not merely whoever holds a DIRECTOR shift. queueEmail records one
// EmailLog per recipient (personId + template), so we assert on that.
// ---------------------------------------------------------------------------

async function createPersonWithEmail(name: string, contactEmail: string) {
  return prisma.person.create({ data: { name, contactEmail } });
}

describe("createRequest approver notifications (L1)", () => {
  it("notifies a department director who holds a DIRECTOR membership but NO DIRECTOR shift", async () => {
    const dates = sixSaturdays();
    const term = await createTerm("ACTIVE", dates);
    const dept = await createDepartment("NOTA");
    const requester = await createPerson("Requester");

    // Director oversees the department by membership only; they are NOT on any
    // DIRECTOR shift, so the old shift-assignment recipient query missed them.
    const director = await createPersonWithEmail("Off-shift Dir", "dir@example.org");
    await createMembership(director.id, term.id, dept.id, "DIRECTOR");
    await createMembership(requester.id, term.id, dept.id, "VOLUNTEER");

    await createShift(term.id, dept.id, requester.id, dates[0], "VOLUNTEER");

    await createRequest(requester.id, {
      termId: term.id,
      requesterDateKey: isoDateKey(dates[0]),
      departmentId: dept.id,
    });

    const notice = await prisma.emailLog.findFirst({
      where: { template: "schedule-request-submitted-director", personId: director.id },
    });
    expect(notice).not.toBeNull();
    expect(notice?.toEmail).toBe("dir@example.org");
  });

  it("notifies a one-hop delegated director (PCAR director for an SCTP request)", async () => {
    const dates = sixSaturdays();
    const term = await createTerm("ACTIVE", dates);
    const pcar = await createDepartment("PCAR");
    const sctp = await createDepartment("SCTP");
    await delegate(pcar.id, sctp.id);

    const requester = await createPerson("SCTP Vol");
    const pcarDirector = await createPersonWithEmail("PCAR Dir", "pcar@example.org");
    await createMembership(pcarDirector.id, term.id, pcar.id, "DIRECTOR");
    await createMembership(requester.id, term.id, sctp.id, "VOLUNTEER");

    await createShift(term.id, sctp.id, requester.id, dates[0], "VOLUNTEER");

    await createRequest(requester.id, {
      termId: term.id,
      requesterDateKey: isoDateKey(dates[0]),
      departmentId: sctp.id,
    });

    const notice = await prisma.emailLog.findFirst({
      where: { template: "schedule-request-submitted-director", personId: pcarDirector.id },
    });
    expect(notice).not.toBeNull();
    expect(notice?.toEmail).toBe("pcar@example.org");
  });
});

// ---------------------------------------------------------------------------
// requestApproverRecipients (audit M3)
//
// The exported helper backs both the createRequest/remindDirectors notifications
// AND the 48h pending-request reminder cron. It must return the department's
// ACTUAL approvers (directors by ACTIVE membership + one-hop delegated directors
// + in-department schedule.manage_requests holders), NOT whoever holds a DIRECTOR
// shift on the calendar. Mirrors the createRequest L1 recipient tests above.
// ---------------------------------------------------------------------------

describe("requestApproverRecipients (M3)", () => {
  it("includes a director who holds a DIRECTOR membership but NO DIRECTOR shift", async () => {
    const dates = sixSaturdays();
    const term = await createTerm("ACTIVE", dates);
    const dept = await createDepartment("APR1");

    const director = await createPersonWithEmail("Off-shift Dir", "dir@example.org");
    await createMembership(director.id, term.id, dept.id, "DIRECTOR");

    const recipients = await requestApproverRecipients(dept.id, term.id);

    expect(recipients.map((r) => r.id)).toContain(director.id);
    expect(recipients.find((r) => r.id === director.id)?.contactEmail).toBe("dir@example.org");
  });

  it("includes a one-hop delegated director (PCAR director for an SCTP request)", async () => {
    const dates = sixSaturdays();
    const term = await createTerm("ACTIVE", dates);
    const pcar = await createDepartment("PCAR");
    const sctp = await createDepartment("SCTP");
    await delegate(pcar.id, sctp.id);

    const pcarDirector = await createPersonWithEmail("PCAR Dir", "pcar@example.org");
    await createMembership(pcarDirector.id, term.id, pcar.id, "DIRECTOR");

    const recipients = await requestApproverRecipients(sctp.id, term.id);

    expect(recipients.map((r) => r.id)).toContain(pcarDirector.id);
  });

  it("includes an in-department schedule.manage_requests holder", async () => {
    const dates = sixSaturdays();
    const term = await createTerm("ACTIVE", dates);
    const dept = await createDepartment("APR2");

    const manager = await createPersonWithEmail("Manage Reqs", "mgr@example.org");
    await createMembership(manager.id, term.id, dept.id, "VOLUNTEER");
    await grantPermission(manager.id, "schedule.manage_requests");

    const recipients = await requestApproverRecipients(dept.id, term.id);

    expect(recipients.map((r) => r.id)).toContain(manager.id);
  });

  it("excludes a blanket schedule.edit_all admin who is not a member or director", async () => {
    const dates = sixSaturdays();
    const term = await createTerm("ACTIVE", dates);
    const dept = await createDepartment("APR3");

    // A real director so the set is non-empty and we prove the admin is dropped
    // rather than everyone being dropped.
    const director = await createPersonWithEmail("Real Dir", "real@example.org");
    await createMembership(director.id, term.id, dept.id, "DIRECTOR");

    const admin = await createPersonWithEmail("Org Admin", "admin@example.org");
    await grantPermission(admin.id, "schedule.edit_all");

    const recipients = await requestApproverRecipients(dept.id, term.id);

    expect(recipients.map((r) => r.id)).toContain(director.id);
    expect(recipients.map((r) => r.id)).not.toContain(admin.id);
  });

  it("excludes someone who only holds a DIRECTOR shift but has no DIRECTOR membership", async () => {
    const dates = sixSaturdays();
    const term = await createTerm("ACTIVE", dates);
    const dept = await createDepartment("APR4");

    // On a DIRECTOR shift, but their membership is VOLUNTEER-kind -- the old
    // shift-assignment heuristic would have reminded them; the approver set does not.
    const shiftOnlyDirector = await createPersonWithEmail("Shift Dir", "shift@example.org");
    await createMembership(shiftOnlyDirector.id, term.id, dept.id, "VOLUNTEER");
    await createShift(term.id, dept.id, shiftOnlyDirector.id, dates[0], "DIRECTOR");

    const recipients = await requestApproverRecipients(dept.id, term.id);

    expect(recipients.map((r) => r.id)).not.toContain(shiftOnlyDirector.id);
  });

  it("resolves the passed term's directors, not the active term's", async () => {
    // dept "directed" by approverA in the live term and approverB in the next
    // term. departmentDirectorPersonIds (the DIRECTOR-kind half) is a
    // documented active-term-only deferral (see requests.ts), so neither
    // person is given a DIRECTOR-kind membership here -- that would collapse
    // to the active term regardless of the termId argument and prove nothing.
    // Instead this exercises the half that DID become term-aware: an ACTIVE
    // member of the department, in the given term, who holds
    // schedule.manage_requests (a global, non-term-scoped grant, so the only
    // thing distinguishing the two is which term's membership row matches).
    const live = await createTerm("ACTIVE", []);
    const next = await createTerm("PLANNING", []);
    const dept = await createDepartment("APR5");
    const approverA = await createPersonWithEmail("ApproverA", "a@x.edu");
    const approverB = await createPersonWithEmail("ApproverB", "b@x.edu");
    await createMembership(approverA.id, live.id, dept.id, "VOLUNTEER");
    await createMembership(approverB.id, next.id, dept.id, "VOLUNTEER");
    await grantPermission(approverA.id, "schedule.manage_requests");
    await grantPermission(approverB.id, "schedule.manage_requests");

    const nextRecipients = await requestApproverRecipients(dept.id, next.id);
    expect(nextRecipients.map((r) => r.id)).toContain(approverB.id);
    expect(nextRecipients.map((r) => r.id)).not.toContain(approverA.id);
  });
});

describe("remindDirectors throttle (F15)", () => {
  it("skips an approver notified within the window so repeated clicks can't flood directors", async () => {
    const dates = sixSaturdays();
    const term = await createTerm("ACTIVE", dates);
    const dept = await createDepartment("AABB");
    const director = await createPersonWithEmail("Dir", "dir@example.org");
    const requester = await createPerson("Vol");
    await createMembership(director.id, term.id, dept.id, "DIRECTOR");
    await createMembership(requester.id, term.id, dept.id, "VOLUNTEER");
    await createShift(term.id, dept.id, requester.id, dates[0], "VOLUNTEER");

    const req = await createRequest(requester.id, {
      termId: term.id,
      requesterDateKey: isoDateKey(dates[0]),
      departmentId: dept.id,
    });
    // Age the request past the 5-day reminder gate.
    await prisma.shiftRequest.update({
      where: { id: req.id },
      data: { createdAt: new Date(Date.now() - 6 * 24 * 60 * 60 * 1000) },
    });
    // Start clean: drop the original submission-notice email so we isolate the
    // reminder throttle.
    await prisma.emailLog.deleteMany({});

    const template = "schedule-request-submitted-director";
    const count = () => prisma.emailLog.count({ where: { personId: director.id, template } });

    await remindDirectors(requester.id, req.id);
    expect(await count()).toBe(1);

    // Immediate second reminder: throttled, no new email.
    await remindDirectors(requester.id, req.id);
    expect(await count()).toBe(1);

    // Push the sole reminder outside the 3-day window; a new reminder now sends.
    await prisma.emailLog.updateMany({
      where: { personId: director.id, template },
      data: { createdAt: new Date(Date.now() - 4 * 24 * 60 * 60 * 1000) },
    });
    await remindDirectors(requester.id, req.id);
    expect(await count()).toBe(2);
  });

  it("returns the number of reminders enqueued so a fully-throttled remind reports 0 (#113)", async () => {
    const dates = sixSaturdays();
    const term = await createTerm("ACTIVE", dates);
    const dept = await createDepartment("AABB");
    const director = await createPersonWithEmail("Dir", "dir@example.org");
    const requester = await createPerson("Vol");
    await createMembership(director.id, term.id, dept.id, "DIRECTOR");
    await createMembership(requester.id, term.id, dept.id, "VOLUNTEER");
    await createShift(term.id, dept.id, requester.id, dates[0], "VOLUNTEER");
    const req = await createRequest(requester.id, {
      termId: term.id,
      requesterDateKey: isoDateKey(dates[0]),
      departmentId: dept.id,
    });
    await prisma.shiftRequest.update({
      where: { id: req.id },
      data: { createdAt: new Date(Date.now() - 6 * 24 * 60 * 60 * 1000) },
    });
    await prisma.emailLog.deleteMany({});

    // First remind: the director is not throttled -> one reminder enqueued.
    expect(await remindDirectors(requester.id, req.id)).toBe(1);
    // Second remind: the director is now throttled -> zero enqueued, so the action
    // can tell the requester nothing was sent instead of a false "Reminder sent".
    expect(await remindDirectors(requester.id, req.id)).toBe(0);
  });
});

describe("countPendingApprovals cross-term", () => {
  // A director managing a department via a live-term directorship. createRequest
  // lets a member raise a drop/swap against a published next (PLANNING) term, and
  // the cron emails this director about it, so the count must include it too.
  // A (requesterId, requesterDate, departmentId) unique constraint means each
  // request needs a distinct date; sixSaturdays gives six clinic dates to pick from.
  async function pendingRequest(termId: string, deptId: string, requesterId: string, dateIdx: number) {
    return prisma.shiftRequest.create({
      data: { termId, departmentId: deptId, requesterId, requesterDate: sixSaturdays()[dateIdx], status: "PENDING" },
    });
  }

  it("counts PENDING requests on the live AND the next term", async () => {
    const live = await createTerm("ACTIVE", []);
    const next = await createTerm("PLANNING", []);
    const dept = await createDepartment("AABB");
    const director = await createPerson("Director");
    const vol = await createPerson("Volunteer");
    await createMembership(director.id, live.id, dept.id, "DIRECTOR");
    await pendingRequest(live.id, dept.id, vol.id, 0);
    await pendingRequest(next.id, dept.id, vol.id, 1);

    expect(await countPendingApprovals(director.id)).toBe(2);
  });

  it("excludes PENDING requests on an ARCHIVED term", async () => {
    const live = await createTerm("ACTIVE", []);
    const archived = await createTerm("ARCHIVED", []);
    const dept = await createDepartment("AABB");
    const director = await createPerson("Director");
    const vol = await createPerson("Volunteer");
    await createMembership(director.id, live.id, dept.id, "DIRECTOR");
    await pendingRequest(live.id, dept.id, vol.id, 0);
    await pendingRequest(archived.id, dept.id, vol.id, 1);

    expect(await countPendingApprovals(director.id)).toBe(1);
  });
});
