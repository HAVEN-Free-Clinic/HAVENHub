import { describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { getEhsDashboard } from "./status";

describe("getEhsDashboard", () => {
  it("returns active trainings and one row per active-term roster member", async () => {
    const admin = await prisma.person.findFirstOrThrow({
      where: { roleAssignments: { some: {} } },
    });
    const dash = await getEhsDashboard(admin.id);
    expect(Array.isArray(dash.trainings)).toBe(true);
    expect(Array.isArray(dash.rows)).toBe(true);
    for (const row of dash.rows) {
      expect(row.cells.length).toBe(dash.trainings.length);
    }
  });
});
