/**
 * Integration tests for the auto-assign endpoint.
 *
 * Nothing gates this route except what it does itself, so the authorization
 * cases are the load-bearing ones: a preview exposes a department's whole
 * roster and everybody's availability, and applying writes to their schedule.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { isoDateKey } from "@/platform/dates";

vi.mock("@/platform/auth/auth", () => ({ auth: vi.fn() }));
vi.mock("@/platform/auth/match-person", () => ({ getActivePerson: vi.fn() }));

import { auth } from "@/platform/auth/auth";
import { getActivePerson } from "@/platform/auth/match-person";
import { POST } from "./route";

const mocked = (fn: unknown) => fn as unknown as ReturnType<typeof vi.fn>;

function utcNoon(year: number, month: number, day: number): Date {
  return new Date(Date.UTC(year, month - 1, day, 12, 0, 0, 0));
}

const SATURDAY = utcNoon(2026, 6, 6);
const DATE_KEY = isoDateKey(SATURDAY);

beforeEach(resetDb);

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
    where: { code: "INTP" },
    update: {},
    create: { code: "INTP", name: "Interpreting", maxVolunteersPerShift: 20 },
  });
  const other = await prisma.department.upsert({
    where: { code: "VADM" },
    update: {},
    create: { code: "VADM", name: "Vaccine Administration" },
  });
  const director = await prisma.person.create({ data: { name: "Dana Director" } });
  const volunteer = await prisma.person.create({ data: { name: "Vic Volunteer" } });
  const outsider = await prisma.person.create({ data: { name: "Otto Outsider" } });

  for (const [person, kind, department, availability] of [
    [director, "DIRECTOR", dept, []],
    [volunteer, "VOLUNTEER", dept, [SATURDAY]],
    [outsider, "DIRECTOR", other, []],
  ] as const) {
    await prisma.termMembership.create({
      data: {
        personId: person.id,
        termId: term.id,
        departmentId: department.id,
        kind,
        status: "ACTIVE",
        baselineAvailability: [...availability],
      },
    });
  }
  return { term, dept, director, volunteer, outsider };
}

function post(body: unknown): Request {
  return new Request("http://localhost/api/schedule/auto-assign", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function signedInAs(person: { id: string } | null) {
  mocked(auth).mockResolvedValue(person ? { personId: person.id } : null);
  mocked(getActivePerson).mockResolvedValue(person);
}

describe("POST /api/schedule/auto-assign", () => {
  it("rejects a caller who is not signed in", async () => {
    signedInAs(null);
    const res = await POST(post({ termId: "t", departmentId: "d", kind: "preview" }));
    expect(res.status).toBe(401);
  });

  it("refuses a preview for a department the caller does not manage", async () => {
    const { term, dept, outsider } = await fixture();
    signedInAs(outsider);

    const res = await POST(post({ termId: term.id, departmentId: dept.id, kind: "preview" }));
    expect(res.status).toBe(403);
  });

  it("previews without writing anything", async () => {
    const { term, dept, director, volunteer } = await fixture();
    signedInAs(director);

    const res = await POST(post({ termId: term.id, departmentId: dept.id, kind: "preview" }));
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.proposal.additions).toEqual([{ dateKey: DATE_KEY, memberId: volunteer.id }]);
    expect(body.cap).toBe(20);
    expect(await prisma.shiftAssignment.count()).toBe(0);
  });

  it("applies a proposal onto the board", async () => {
    const { term, dept, director, volunteer } = await fixture();
    signedInAs(director);

    const res = await POST(
      post({
        termId: term.id,
        departmentId: dept.id,
        kind: "apply",
        additions: [{ dateKey: DATE_KEY, memberId: volunteer.id }],
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ applied: 1, skipped: 0 });
    expect(await prisma.shiftAssignment.count({ where: { personId: volunteer.id } })).toBe(1);
  });

  it("rejects a malformed body", async () => {
    const { director } = await fixture();
    signedInAs(director);

    const res = await POST(post({ termId: "t", departmentId: "d", kind: "nonsense" }));
    expect(res.status).toBe(400);
  });
});
