import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { getEhsDashboard } from "./status";

beforeEach(resetDb);

describe("getEhsDashboard for the next term", () => {
  it("lists the next term's roster, with completions already on file carried over", async () => {
    const live = await prisma.term.create({
      data: { code: "SU26", name: "Summer 2026", startDate: new Date("2026-05-30"), endDate: new Date("2026-09-26"), status: "ACTIVE" },
    });
    const next = await prisma.term.create({
      data: { code: "FA26", name: "Fall 2026", startDate: new Date("2026-10-03"), endDate: new Date("2027-01-01"), status: "PLANNING" },
    });
    const dept = await prisma.department.create({ data: { code: "PATS", name: "Patient Services" } });
    const training = await prisma.ehsTraining.create({
      data: { name: "Chemical - Hazard Communication", isActive: true, requiredForAll: true, position: 0 },
    });
    const returner = await prisma.person.create({ data: { name: "Remy Returner", status: "ACTIVE" } });
    const newcomer = await prisma.person.create({ data: { name: "Nova Newcomer", status: "ACTIVE" } });
    const summerOnly = await prisma.person.create({ data: { name: "Sam Summer", status: "ACTIVE" } });
    const memberships: [string, string][] = [
      [returner.id, live.id],
      [returner.id, next.id],
      [newcomer.id, next.id],
      [summerOnly.id, live.id],
    ];
    for (const [personId, termId] of memberships) {
      await prisma.termMembership.create({ data: { personId, termId, departmentId: dept.id, kind: "VOLUNTEER" } });
    }
    await prisma.ehsCompletion.create({
      data: { personId: returner.id, trainingId: training.id, source: "MANUAL", completedAt: new Date("2026-06-01") },
    });

    const fall = await getEhsDashboard(next.id);
    const summer = await getEhsDashboard();

    expect(fall.rows.map((r) => r.name).sort()).toEqual(["Nova Newcomer", "Remy Returner"]);
    expect(fall.rows.find((r) => r.name === "Remy Returner")?.cells[0].state).toBe("COMPLETE");
    expect(fall.rows.find((r) => r.name === "Nova Newcomer")?.cells[0].state).toBe("MISSING");
    expect(summer.rows.map((r) => r.name).sort()).toEqual(["Remy Returner", "Sam Summer"]);
  });
});
