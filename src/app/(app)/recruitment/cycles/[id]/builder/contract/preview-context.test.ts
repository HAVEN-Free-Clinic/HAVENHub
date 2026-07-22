import { describe, it, expect, beforeEach } from "vitest";
import { resetDb } from "@/platform/test/db";
import { prisma } from "@/platform/db";
import { loadOnboardingPreviewContext } from "./preview-context";

beforeEach(async () => {
  await resetDb();
});

describe("loadOnboardingPreviewContext", () => {
  it("loads the named departments with their Epic flags and formatted training", async () => {
    await prisma.department.create({ data: { code: "IM", name: "Internal Medicine", requiresEpicVolunteer: "SOME", isActive: true } });
    await prisma.department.create({ data: { code: "OFF", name: "Inactive", isActive: false } });
    const ctx = await loadOnboardingPreviewContext({
      departmentCodes: ["IM"],
      fixedTrack: "VOLUNTEER",
      inPersonTrainingDate: new Date(Date.UTC(2026, 4, 3, 12)),
      trainingLocation: "Room 100",
      title: "Fall 2026",
    });
    expect(ctx.departments).toEqual([
      { code: "IM", name: "Internal Medicine", requiresEpicDirector: "NONE", requiresEpicVolunteer: "SOME" },
    ]);
    expect(ctx.fixedTrack).toBe("VOLUNTEER");
    expect(ctx.title).toBe("Fall 2026");
    expect(ctx.trainingDate).toContain("May"); // formatted, not a placeholder
    expect(ctx.trainingLocation).toBe(" Room 100");
    expect(ctx.todayIso).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("loads all active departments in global mode with placeholder training", async () => {
    await prisma.department.create({ data: { code: "IM", name: "Internal Medicine", isActive: true } });
    await prisma.department.create({ data: { code: "OFF", name: "Inactive", isActive: false } });
    const ctx = await loadOnboardingPreviewContext({
      departmentCodes: "all",
      fixedTrack: null,
      inPersonTrainingDate: null,
      trainingLocation: null,
      title: "master template",
    });
    expect(ctx.departments.map((d) => d.code)).toEqual(["IM"]);
    expect(ctx.fixedTrack).toBeNull();
    expect(ctx.trainingLocation).toBe(""); // placeholder for no location
  });
});
