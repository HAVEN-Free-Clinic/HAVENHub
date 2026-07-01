import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { getEhsDashboard } from "./status";
import { createTraining } from "./trainings";
import { markEhsComplete } from "./completion";

beforeEach(resetDb);
afterEach(resetDb);

describe("getEhsDashboard", () => {
  it("returns active trainings and one row per active-term roster member", async () => {
    // Build fixtures
    const actor = await prisma.person.create({ data: { name: "Admin", status: "ACTIVE" } });
    const term = await prisma.term.create({
      data: {
        code: "SU26",
        name: "Summer 2026",
        startDate: new Date("2026-05-01T00:00:00.000Z"),
        endDate: new Date("2026-08-31T00:00:00.000Z"),
        status: "ACTIVE",
      },
    });
    const dept = await prisma.department.create({ data: { code: "PCAR", name: "Primary Care" } });
    const person = await prisma.person.create({ data: { name: "Volunteer", status: "ACTIVE" } });
    await prisma.termMembership.create({
      data: { personId: person.id, termId: term.id, departmentId: dept.id, kind: "VOLUNTEER", status: "ACTIVE" },
    });
    const training = await createTraining({ name: "BBP Clinical" }, actor.id);

    const dash = await getEhsDashboard();

    expect(dash.trainings.length).toBeGreaterThanOrEqual(1);
    expect(dash.trainings.some((t) => t.id === training.id)).toBe(true);

    const row = dash.rows.find((r) => r.personId === person.id);
    expect(row).toBeDefined();
    expect(row!.addedToEhs).toBe(false);
    expect(row!.cells.length).toBe(dash.trainings.length);

    const cell = row!.cells.find((c) => c.trainingId === training.id);
    expect(cell!.state).toBe("MISSING");
  });

  it("reflects COMPLETE after markEhsComplete", async () => {
    const actor = await prisma.person.create({ data: { name: "Admin", status: "ACTIVE" } });
    const term = await prisma.term.create({
      data: {
        code: "SU26",
        name: "Summer 2026",
        startDate: new Date("2026-05-01T00:00:00.000Z"),
        endDate: new Date("2026-08-31T00:00:00.000Z"),
        status: "ACTIVE",
      },
    });
    const dept = await prisma.department.create({ data: { code: "PCAR", name: "Primary Care" } });
    const person = await prisma.person.create({ data: { name: "Volunteer", status: "ACTIVE" } });
    await prisma.termMembership.create({
      data: { personId: person.id, termId: term.id, departmentId: dept.id, kind: "VOLUNTEER", status: "ACTIVE" },
    });
    const training = await createTraining({ name: "BBP Clinical" }, actor.id);

    await markEhsComplete(person.id, training.id, actor.id, new Date("2026-03-01"));

    const dash = await getEhsDashboard();
    const row = dash.rows.find((r) => r.personId === person.id);
    const cell = row!.cells.find((c) => c.trainingId === training.id);
    expect(cell!.state).toBe("COMPLETE");
  });
});
