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
  RequestForbiddenError,
  RequestNotFoundError,
  RequestValidationError,
} from "./requests";
import { isoDateKey } from "@/platform/dates";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function utcNoon(year: number, month: number, day: number): Date {
  return new Date(Date.UTC(year, month - 1, day, 12, 0, 0, 0));
}

/** Six consecutive Saturdays starting 2026-06-06, anchored at noon UTC. */
function sixSaturdays(): Date[] {
  // 2026-06-06 is a Saturday
  const base = utcNoon(2026, 6, 6);
  return Array.from({ length: 6 }, (_, i) => new Date(base.getTime() + i * 7 * 86400000));
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
      code: `SU26-${Date.now()}`,
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

    await createShift(term.id, dept.id, actor.id, dates[0], "VOLUNTEER");

    const req = await createRequest(actor.id, {
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

    await createShift(term.id, dept.id, actor.id, dates[0], "VOLUNTEER");
    await createShift(term.id, dept.id, target.id, dates[1], "VOLUNTEER");

    const req = await createRequest(actor.id, {
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
    await createTerm("ACTIVE", dates);
    const dept = await createDepartment("AABB");
    const actor = await createPerson("Alice");
    // No shift created

    await expect(
      createRequest(actor.id, {
        requesterDateKey: isoDateKey(dates[0]),
        departmentId: dept.id,
      })
    ).rejects.toBeInstanceOf(RequestValidationError);
  });

  it("rejects when requesterDateKey is not a clinic date", async () => {
    const dates = sixSaturdays();
    await createTerm("ACTIVE", dates);
    const dept = await createDepartment("AABB");
    const actor = await createPerson("Alice");

    await expect(
      createRequest(actor.id, {
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

    await createShift(term.id, dept.id, actor.id, dates[0], "SHADOW");
    await createShift(term.id, dept.id, target.id, dates[1], "VOLUNTEER");

    await expect(
      createRequest(actor.id, {
        requesterDateKey: isoDateKey(dates[0]),
        departmentId: dept.id,
        targetId: target.id,
        targetDateKey: isoDateKey(dates[1]),
      })
    ).rejects.toBeInstanceOf(RequestValidationError);

    await expect(
      createRequest(actor.id, {
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

    await createShift(term.id, dept.id, actor.id, dates[0], "VOLUNTEER");

    await createRequest(actor.id, {
      requesterDateKey: isoDateKey(dates[0]),
      departmentId: dept.id,
    });

    await expect(
      createRequest(actor.id, {
        requesterDateKey: isoDateKey(dates[0]),
        departmentId: dept.id,
      })
    ).rejects.toBeInstanceOf(RequestValidationError);

    await expect(
      createRequest(actor.id, {
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

    await createShift(term.id, dept.id, actor.id, dates[0], "VOLUNTEER");

    const first = await createRequest(actor.id, {
      requesterDateKey: isoDateKey(dates[0]),
      departmentId: dept.id,
    });

    await cancelRequest(actor.id, first.id);

    const second = await createRequest(actor.id, {
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
    await createShift(term.id, dept.id, requester.id, dates[0], "VOLUNTEER");
    await createShift(term.id, dept.id, target.id, dates[1], "VOLUNTEER");
    await createShift(term.id, dept.id, target.id, dates[0], "SHADOW");

    await expect(
      createRequest(requester.id, {
        requesterDateKey: isoDateKey(dates[0]),
        departmentId: dept.id,
        targetId: target.id,
        targetDateKey: isoDateKey(dates[1]),
      })
    ).rejects.toBeInstanceOf(RequestValidationError);

    await expect(
      createRequest(requester.id, {
        requesterDateKey: isoDateKey(dates[0]),
        departmentId: dept.id,
        targetId: target.id,
        targetDateKey: isoDateKey(dates[1]),
      })
    ).rejects.toThrow("Partner is not eligible");
  });

  it("rejects when no active term", async () => {
    await createTerm("ARCHIVED", []);
    const dept = await createDepartment("AABB");
    const actor = await createPerson("Alice");

    await expect(
      createRequest(actor.id, {
        requesterDateKey: "2026-06-06",
        departmentId: dept.id,
      })
    ).rejects.toBeInstanceOf(RequestValidationError);
  });
});

describe("cancelRequest", () => {
  it("requester can cancel their own PENDING request", async () => {
    const dates = sixSaturdays();
    const term = await createTerm("ACTIVE", dates);
    const dept = await createDepartment("AABB");
    const actor = await createPerson("Alice");

    await createShift(term.id, dept.id, actor.id, dates[0], "VOLUNTEER");
    const req = await createRequest(actor.id, {
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

    await createShift(term.id, dept.id, actor.id, dates[0], "VOLUNTEER");
    const req = await createRequest(actor.id, {
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
    await createShift(term.id, dept.id, actor.id, dates[0], "VOLUNTEER");

    const req = await createRequest(actor.id, {
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
    await createShift(term.id, dept.id, vol1.id, dates[0], "VOLUNTEER");
    await createShift(term.id, dept.id, vol2.id, dates[1], "VOLUNTEER");
    await createShift(term.id, dept.id, vol3.id, dates[2], "VOLUNTEER");
    await createShift(term.id, dept.id, director.id, dates[3], "DIRECTOR");

    // Create two pending requests
    const pending1 = await createRequest(vol1.id, { requesterDateKey: isoDateKey(dates[0]), departmentId: dept.id });
    const pending2 = await createRequest(vol2.id, { requesterDateKey: isoDateKey(dates[1]), departmentId: dept.id });

    // Deny one so it becomes decided
    await denyRequest(director.id, pending1.id);

    const rows = await listDepartmentRequests(director.id, dept.id);

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
      await createShift(term.id, dept.id, vol.id, dates[0], "VOLUNTEER");
      const req = await createRequest(vol.id, {
        requesterDateKey: isoDateKey(dates[0]),
        departmentId: dept.id,
      });
      await cancelRequest(vol.id, req.id);
    }

    // A genuine denial happens last, so it is the most recent terminal event.
    const denied = await createPerson("Denied Vol");
    await createShift(term.id, dept.id, denied.id, dates[1], "VOLUNTEER");
    const deniedReq = await createRequest(denied.id, {
      requesterDateKey: isoDateKey(dates[1]),
      departmentId: dept.id,
    });
    await denyRequest(director.id, deniedReq.id);

    const rows = await listDepartmentRequests(director.id, dept.id);
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
      requesterDateKey: isoDateKey(dates[0]),
      departmentId: dept.id,
      targetId: target.id,
      targetDateKey: isoDateKey(dates[1]),
    });

    await approveRequest(director.id, req.id);

    const rows = await listDepartmentRequests(director.id, dept.id);
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

    const rows = await listDepartmentRequests(director.id, dept.id);
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

    const rows = await listDepartmentRequests(director.id, sctp.id);
    expect(Array.isArray(rows)).toBe(true);
  });

  it("schedule.edit_all grant allows listing any department", async () => {
    const dates = sixSaturdays();
    await createTerm("ACTIVE", dates);
    const dept = await createDepartment("AABB");
    const actor = await createPerson("Admin");

    await grantPermission(actor.id, "schedule.edit_all");

    const rows = await listDepartmentRequests(actor.id, dept.id);
    expect(Array.isArray(rows)).toBe(true);
  });

  it("outsider (no membership, no grant) gets RequestForbiddenError", async () => {
    const dates = sixSaturdays();
    await createTerm("ACTIVE", dates);
    const dept = await createDepartment("AABB");
    const outsider = await createPerson("Outsider");

    await expect(listDepartmentRequests(outsider.id, dept.id)).rejects.toBeInstanceOf(
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
    await createShift(term.id, dept.id, vol.id, dates[0], "VOLUNTEER");

    const req = await createRequest(vol.id, {
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
    await createShift(term.id, dept.id, vol1.id, dates[0], "VOLUNTEER");
    const targetShift = await createShift(term.id, dept.id, vol2.id, dates[1], "VOLUNTEER");

    const req = await createRequest(vol1.id, {
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
    await createShift(term.id, dept.id, vol1.id, dates[0], "VOLUNTEER");
    await createShift(term.id, dept.id, vol2.id, dates[1], "VOLUNTEER");

    // Create a valid swap request
    const req = await createRequest(vol1.id, {
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
    await createShift(term.id, dept.id, vol1.id, dates[0], "VOLUNTEER");
    await createShift(term.id, dept.id, vol2.id, dates[1], "VOLUNTEER");

    // Create a valid swap request
    const req = await createRequest(vol1.id, {
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
    await createShift(term.id, dept.id, vol.id, dates[0], "VOLUNTEER");

    const req = await createRequest(vol.id, {
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
    await createShift(term.id, dept.id, vol1.id, dates[0], "VOLUNTEER");
    await createShift(term.id, dept.id, offboarded.id, dates[1], "VOLUNTEER");

    // The swap request is created while the target is still active.
    const req = await createRequest(vol1.id, {
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
});

describe("denyRequest", () => {
  it("sets status DENIED, appends note, records decidedBy/At", async () => {
    const dates = sixSaturdays();
    const term = await createTerm("ACTIVE", dates);
    const dept = await createDepartment("AABB");
    const director = await createPerson("Director");
    const vol = await createPerson("Volunteer");

    await createMembership(director.id, term.id, dept.id, "DIRECTOR");
    await createShift(term.id, dept.id, vol.id, dates[0], "VOLUNTEER");

    const req = await createRequest(vol.id, {
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
    await createShift(term.id, dept.id, vol.id, dates[0], "VOLUNTEER");

    const req = await createRequest(vol.id, {
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
    await createShift(term.id, dept.id, vol.id, dates[0], "VOLUNTEER");

    const req = await createRequest(vol.id, {
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

    const partners = await eligibleSwapPartners(actor.id, isoDateKey(dates[0]), dept.id);

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

    const partners = await eligibleSwapPartners(actor.id, isoDateKey(dates[0]), dept.id);

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

    const partners = await eligibleSwapPartners(actor.id, isoDateKey(dates[0]), deptA.id);

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

    const partners = await eligibleSwapPartners(actor.id, isoDateKey(dates[0]), dept.id);

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

    const partners = await eligibleSwapPartners(actor.id, isoDateKey(dates[0]), dept.id);

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

    const partners = await eligibleSwapPartners(actor.id, isoDateKey(dates[0]), dept.id);

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

    const partners = await eligibleSwapPartners(actor.id, isoDateKey(dates[0]), dept.id);
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

    const partners = await eligibleSwapPartners(actor.id, isoDateKey(dates[0]), dept.id);
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

    const partners = await eligibleSwapPartners(actor.id, isoDateKey(dates[0]), dept.id);

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

    const partners = await eligibleSwapPartners(actor.id, isoDateKey(dates[0]), dept.id);

    const ids = partners.map((p) => p.personId);
    expect(ids).not.toContain(collidingPartner.id);
    expect(ids).toContain(cleanPartner.id);
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
    await expect(listDepartmentRequests(actor.id, dept.id)).resolves.toEqual([]);
  });

  it("forbids a member without schedule.manage_requests", async () => {
    const dates = sixSaturdays();
    const term = await createTerm("ACTIVE", dates);
    const dept = await createDepartment("MRQ2");
    const actor = await createPerson("PlainMember");
    await createMembership(actor.id, term.id, dept.id, "VOLUNTEER");

    await expect(listDepartmentRequests(actor.id, dept.id)).rejects.toBeInstanceOf(RequestForbiddenError);
  });

  it("schedule.edit_own_dept alone does NOT grant request decisions", async () => {
    const dates = sixSaturdays();
    const term = await createTerm("ACTIVE", dates);
    const dept = await createDepartment("MRQ3");
    const actor = await createPerson("EditOnly");
    await createMembership(actor.id, term.id, dept.id, "VOLUNTEER");
    await grantPermission(actor.id, "schedule.edit_own_dept");

    await expect(listDepartmentRequests(actor.id, dept.id)).rejects.toBeInstanceOf(RequestForbiddenError);
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

    await createShift(term.id, dept.id, requester.id, dates[0], "VOLUNTEER");

    await createRequest(requester.id, {
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

    await createShift(term.id, sctp.id, requester.id, dates[0], "VOLUNTEER");

    await createRequest(requester.id, {
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

    const recipients = await requestApproverRecipients(dept.id);

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

    const recipients = await requestApproverRecipients(sctp.id);

    expect(recipients.map((r) => r.id)).toContain(pcarDirector.id);
  });

  it("includes an in-department schedule.manage_requests holder", async () => {
    const dates = sixSaturdays();
    const term = await createTerm("ACTIVE", dates);
    const dept = await createDepartment("APR2");

    const manager = await createPersonWithEmail("Manage Reqs", "mgr@example.org");
    await createMembership(manager.id, term.id, dept.id, "VOLUNTEER");
    await grantPermission(manager.id, "schedule.manage_requests");

    const recipients = await requestApproverRecipients(dept.id);

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

    const recipients = await requestApproverRecipients(dept.id);

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

    const recipients = await requestApproverRecipients(dept.id);

    expect(recipients.map((r) => r.id)).not.toContain(shiftOnlyDirector.id);
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
    await createShift(term.id, dept.id, requester.id, dates[0], "VOLUNTEER");

    const req = await createRequest(requester.id, {
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
});
