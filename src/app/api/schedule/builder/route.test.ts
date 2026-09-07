/**
 * Integration tests for the interactive builder's read/write endpoint.
 *
 * This route replaced a set of server actions that were gated by the Builder
 * page itself. Nothing gates it now except what it does here, so the
 * authorization cases below are the load-bearing ones: an outsider must not be
 * able to move a shift in a department they do not manage just because they hold
 * schedule access somewhere else.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { Prisma } from "@prisma/client";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { isoDateKey } from "@/platform/dates";

vi.mock("@/platform/auth/auth", () => ({ auth: vi.fn() }));
vi.mock("@/platform/auth/match-person", () => ({ getActivePerson: vi.fn() }));

import { auth } from "@/platform/auth/auth";
import { getActivePerson } from "@/platform/auth/match-person";

const mocked = (fn: unknown) => fn as unknown as ReturnType<typeof vi.fn>;

function utcNoon(year: number, month: number, day: number): Date {
  return new Date(Date.UTC(year, month - 1, day, 12, 0, 0, 0));
}

const SATURDAY = utcNoon(2026, 6, 6);
const DATE_KEY = isoDateKey(SATURDAY);

/** A term with one clinic date, a department, a director and a volunteer. */
async function fixture() {
  const term = await prisma.term.create({
    data: {
      code: `SU26-${Date.now()}-${Math.random()}`,
      name: "Summer 2026",
      startDate: utcNoon(2026, 5, 30),
      endDate: utcNoon(2026, 9, 26),
      status: "ACTIVE",
      clinicDates: [SATURDAY],
    },
  });
  const dept = await prisma.department.upsert({
    where: { code: "MED" },
    update: {},
    create: { code: "MED", name: "Medicine" },
  });
  const other = await prisma.department.upsert({
    where: { code: "VADM" },
    update: {},
    create: { code: "VADM", name: "Vaccine Administration" },
  });
  const director = await prisma.person.create({ data: { name: "Dana Director" } });
  const volunteer = await prisma.person.create({ data: { name: "Vic Volunteer" } });
  const outsider = await prisma.person.create({ data: { name: "Otto Outsider" } });

  for (const [person, kind, department] of [
    [director, "DIRECTOR", dept],
    [volunteer, "VOLUNTEER", dept],
    [outsider, "DIRECTOR", other],
  ] as const) {
    await prisma.termMembership.create({
      data: {
        personId: person.id,
        termId: term.id,
        departmentId: department.id,
        kind,
        status: "ACTIVE",
        baselineAvailability: [],
        selfAvailabilityDates: [],
        directorAvailabilityDates: [],
      },
    });
  }

  return { term, dept, other, director, volunteer, outsider };
}

function signedInAs(personId: string) {
  mocked(auth).mockResolvedValue({ personId });
  mocked(getActivePerson).mockResolvedValue({ id: personId });
}

function post(body: unknown): Request {
  return new Request("http://localhost/api/schedule/builder", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/schedule/builder", () => {
  beforeEach(async () => {
    await resetDb();
    vi.resetAllMocks();
  });

  it("returns 401 when unauthenticated", async () => {
    mocked(auth).mockResolvedValue(null);
    const { POST } = await import("./route");
    expect((await POST(post({}))).status).toBe(401);
  });

  it("returns 403 for a signed-in person who manages no schedule department", async () => {
    const { term, dept, volunteer } = await fixture();
    signedInAs(volunteer.id);
    const { POST } = await import("./route");
    const res = await POST(
      post({
        termId: term.id,
        departmentId: dept.id,
        dateKey: DATE_KEY,
        personId: volunteer.id,
        kind: "assign",
        role: "VOLUNTEER",
      }),
    );
    expect(res.status).toBe(403);
    expect(await prisma.shiftAssignment.count()).toBe(0);
  });

  // The case this endpoint's authorization exists for: a director of ANOTHER
  // department clears the first gate (they manage a schedule somewhere) and must
  // still be refused by the service's per-department scope check.
  it("returns 403 for a director writing into a department they do not manage", async () => {
    const { term, dept, volunteer, outsider } = await fixture();
    signedInAs(outsider.id);
    const { POST } = await import("./route");
    const res = await POST(
      post({
        termId: term.id,
        departmentId: dept.id,
        dateKey: DATE_KEY,
        personId: volunteer.id,
        kind: "assign",
        role: "VOLUNTEER",
      }),
    );
    expect(res.status).toBe(403);
    expect(await prisma.shiftAssignment.count()).toBe(0);
  });

  it("assigns, and answers with the whole board plus a revision", async () => {
    const { term, dept, director, volunteer } = await fixture();
    signedInAs(director.id);
    const { POST } = await import("./route");
    const res = await POST(
      post({
        termId: term.id,
        departmentId: dept.id,
        dateKey: DATE_KEY,
        personId: volunteer.id,
        kind: "assign",
        role: "VOLUNTEER",
      }),
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.assignments[DATE_KEY][volunteer.id]).toMatchObject({
      role: "VOLUNTEER",
      person: { name: "Vic Volunteer" },
    });
    expect(typeof json.revision).toBe("string");
    expect(await prisma.shiftAssignment.count()).toBe(1);
  });

  it("unassigns, and the board comes back without the cell", async () => {
    const { term, dept, director, volunteer } = await fixture();
    await prisma.shiftAssignment.create({
      data: {
        termId: term.id,
        departmentId: dept.id,
        personId: volunteer.id,
        clinicDate: SATURDAY,
        role: "VOLUNTEER",
      },
    });
    signedInAs(director.id);
    const { POST } = await import("./route");
    const res = await POST(
      post({
        termId: term.id,
        departmentId: dept.id,
        dateKey: DATE_KEY,
        personId: volunteer.id,
        kind: "unassign",
        reason: "swapped out",
      }),
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.assignments[DATE_KEY]?.[volunteer.id]).toBeUndefined();
    expect(await prisma.shiftAssignment.count()).toBe(0);
  });

  it("toggles a tag on an existing assignment", async () => {
    const { term, dept, director, volunteer } = await fixture();
    await prisma.shiftAssignment.create({
      data: {
        termId: term.id,
        departmentId: dept.id,
        personId: volunteer.id,
        clinicDate: SATURDAY,
        role: "VOLUNTEER",
      },
    });
    signedInAs(director.id);
    const { POST } = await import("./route");
    const res = await POST(
      post({
        termId: term.id,
        departmentId: dept.id,
        dateKey: DATE_KEY,
        personId: volunteer.id,
        kind: "tag",
        tag: "triage",
      }),
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.assignments[DATE_KEY][volunteer.id].tags.triage).toBe(true);
  });

  // A rejection has to arrive as an answer the client can show and roll back on,
  // not as a 500 that files an exception.
  it("returns 400 with the message when the service rejects the write", async () => {
    const { term, dept, director, volunteer } = await fixture();
    signedInAs(director.id);
    const { POST } = await import("./route");
    const res = await POST(
      post({
        termId: term.id,
        departmentId: dept.id,
        dateKey: "2026-06-07", // a Sunday: not a clinic date of this term
        personId: volunteer.id,
        kind: "assign",
        role: "VOLUNTEER",
      }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("not a clinic date");
  });

  it("rejects a malformed body before touching the database", async () => {
    const { director } = await fixture();
    signedInAs(director.id);
    const { POST } = await import("./route");
    const res = await POST(
      post({ termId: "t", departmentId: "d", dateKey: "not-a-date", personId: "p", kind: "assign", role: "VOLUNTEER" }),
    );
    expect(res.status).toBe(400);
    expect(await prisma.shiftAssignment.count()).toBe(0);
  });

  it("rejects a role outside the allow-list", async () => {
    const { term, dept, director, volunteer } = await fixture();
    signedInAs(director.id);
    const { POST } = await import("./route");
    const res = await POST(
      post({
        termId: term.id,
        departmentId: dept.id,
        dateKey: DATE_KEY,
        personId: volunteer.id,
        kind: "assign",
        role: "ADMIN",
      }),
    );
    expect(res.status).toBe(400);
  });

  // One Neon blip must not become one filed exception per cell click.
  it("returns 503 when the database is unreachable", async () => {
    mocked(auth).mockResolvedValue({ personId: "p1" });
    mocked(getActivePerson).mockRejectedValue(
      new Prisma.PrismaClientInitializationError(
        "Can't reach database server at ep-broad-brook.neon.tech:5432",
        "5.0.0",
      ),
    );
    const { POST } = await import("./route");
    expect((await POST(post({}))).status).toBe(503);
  });
});

describe("GET /api/schedule/builder", () => {
  beforeEach(async () => {
    await resetDb();
    vi.resetAllMocks();
  });

  function get(termId: string, deptId: string): Request {
    return new Request(
      `http://localhost/api/schedule/builder?term=${termId}&dept=${deptId}`,
    );
  }

  it("returns 401 when unauthenticated", async () => {
    mocked(auth).mockResolvedValue(null);
    const { GET } = await import("./route");
    expect((await GET(get("t", "d"))).status).toBe(401);
  });

  it("returns 400 without a term and department", async () => {
    const { director } = await fixture();
    signedInAs(director.id);
    const { GET } = await import("./route");
    const res = await GET(new Request("http://localhost/api/schedule/builder"));
    expect(res.status).toBe(400);
  });

  it("returns 403 for a department the viewer does not manage", async () => {
    const { term, dept, outsider } = await fixture();
    signedInAs(outsider.id);
    const { GET } = await import("./route");
    expect((await GET(get(term.id, dept.id))).status).toBe(403);
  });

  it("returns the board for a department the viewer manages", async () => {
    const { term, dept, director, volunteer } = await fixture();
    await prisma.shiftAssignment.create({
      data: {
        termId: term.id,
        departmentId: dept.id,
        personId: volunteer.id,
        clinicDate: SATURDAY,
        role: "SHADOW",
      },
    });
    signedInAs(director.id);
    const { GET } = await import("./route");
    const res = await GET(get(term.id, dept.id));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.assignments[DATE_KEY][volunteer.id].role).toBe("SHADOW");
  });
});
