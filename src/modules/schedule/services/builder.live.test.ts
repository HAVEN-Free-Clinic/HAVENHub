/**
 * Integration tests for the live-board reads behind the interactive builder:
 * assignmentsFor (the board a click and the change stream both send) and
 * boardRevision (the stamp that decides whether the stream sends anything).
 *
 * boardRevision is the whole change-detection mechanism, so the cases below are
 * the three ways a board can change. A stamp that misses any of them is a change
 * another director never sees.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { isoDateKey } from "@/platform/dates";
import { assignmentsFor, boardRevision } from "./builder";

function utcNoon(year: number, month: number, day: number): Date {
  return new Date(Date.UTC(year, month - 1, day, 12, 0, 0, 0));
}

const SATURDAY = utcNoon(2026, 6, 6);
const NEXT_SATURDAY = utcNoon(2026, 6, 13);
const DATE_KEY = isoDateKey(SATURDAY);

async function fixture() {
  const term = await prisma.term.create({
    data: {
      code: `SU26-${Date.now()}-${Math.random()}`,
      name: "Summer 2026",
      startDate: utcNoon(2026, 5, 30),
      endDate: utcNoon(2026, 9, 26),
      status: "ACTIVE",
      clinicDates: [SATURDAY, NEXT_SATURDAY],
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
  return { term, dept, other };
}

async function shift(
  termId: string,
  departmentId: string,
  personId: string,
  clinicDate: Date,
  role: "VOLUNTEER" | "SHADOW" | "DIRECTOR" = "VOLUNTEER",
) {
  return prisma.shiftAssignment.create({
    data: { termId, departmentId, personId, clinicDate, role },
  });
}

describe("assignmentsFor", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("keys the board by date then person, carrying role, tags and identity", async () => {
    const { term, dept } = await fixture();
    const person = await prisma.person.create({
      data: {
        name: "Vic Volunteer",
        licensedRN: true,
        languages: {
          create: { language: "es", selfReported: true, verified: true, verifiedAt: new Date() },
        },
      },
    });
    const row = await shift(term.id, dept.id, person.id, SATURDAY);
    await prisma.shiftAssignment.update({ where: { id: row.id }, data: { triage: true } });

    const board = await assignmentsFor(term.id, dept.id);

    expect(board[DATE_KEY][person.id]).toEqual({
      role: "VOLUNTEER",
      tags: { triage: true, walkin: false, cc: false, remote: false, specialty: false },
      // Only VERIFIED languages reach the builder, matching builderView.
      person: { name: "Vic Volunteer", verifiedLanguages: ["es"], licensedRN: true },
    });
  });

  // The board a director is looking at is one department's. Another
  // department's shift for the same person on the same day belongs to that
  // department's board, and pushing it into this one would paint a cell the
  // viewer cannot act on.
  it("covers one department only", async () => {
    const { term, dept, other } = await fixture();
    const person = await prisma.person.create({ data: { name: "Dual Dana" } });
    await shift(term.id, dept.id, person.id, SATURDAY);
    await shift(term.id, other.id, person.id, SATURDAY);

    const board = await assignmentsFor(term.id, dept.id);
    expect(Object.keys(board[DATE_KEY])).toEqual([person.id]);
    expect(await prisma.shiftAssignment.count()).toBe(2);
  });

  it("returns an empty board for a department with nothing on it", async () => {
    const { term, dept } = await fixture();
    expect(await assignmentsFor(term.id, dept.id)).toEqual({});
  });
});

describe("boardRevision", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("moves when an assignment is created", async () => {
    const { term, dept } = await fixture();
    const person = await prisma.person.create({ data: { name: "Vic" } });
    const before = await boardRevision(term.id, dept.id);
    await shift(term.id, dept.id, person.id, SATURDAY);
    expect(await boardRevision(term.id, dept.id)).not.toBe(before);
  });

  // The case a bare row count would miss entirely: a tag toggle or a role change
  // leaves the same number of rows behind.
  it("moves when an assignment is edited in place", async () => {
    const { term, dept } = await fixture();
    const person = await prisma.person.create({ data: { name: "Vic" } });
    const row = await shift(term.id, dept.id, person.id, SATURDAY);
    const before = await boardRevision(term.id, dept.id);
    await prisma.shiftAssignment.update({ where: { id: row.id }, data: { triage: true } });
    expect(await boardRevision(term.id, dept.id)).not.toBe(before);
  });

  // And the case a bare max(updatedAt) would miss: deleting the newest row
  // leaves the maximum sitting on an older one, or on nothing at all.
  it("moves when an assignment is deleted", async () => {
    const { term, dept } = await fixture();
    const person = await prisma.person.create({ data: { name: "Vic" } });
    const row = await shift(term.id, dept.id, person.id, SATURDAY);
    const before = await boardRevision(term.id, dept.id);
    await prisma.shiftAssignment.delete({ where: { id: row.id } });
    expect(await boardRevision(term.id, dept.id)).not.toBe(before);
  });

  it("holds still while nothing changes", async () => {
    const { term, dept } = await fixture();
    const person = await prisma.person.create({ data: { name: "Vic" } });
    await shift(term.id, dept.id, person.id, SATURDAY);
    expect(await boardRevision(term.id, dept.id)).toBe(await boardRevision(term.id, dept.id));
  });

  // Otherwise every viewer of every department would be woken by every change
  // anywhere in the term.
  it("ignores another department's changes", async () => {
    const { term, dept, other } = await fixture();
    const person = await prisma.person.create({ data: { name: "Vic" } });
    const before = await boardRevision(term.id, dept.id);
    await shift(term.id, other.id, person.id, SATURDAY);
    expect(await boardRevision(term.id, dept.id)).toBe(before);
  });
});
