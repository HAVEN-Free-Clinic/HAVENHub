import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resetDb } from "@/platform/test/db";
import { prisma } from "@/platform/db";
import { materializeTemplate } from "./materialize";
import type { TemplateSection } from "./types";

beforeEach(async () => { await resetDb(); });
afterEach(async () => { await resetDb(); });

async function bareCycle() {
  const person = await prisma.person.create({ data: { name: "L", status: "ACTIVE" } });
  const term = await prisma.term.create({ data: { code: "FA26", name: "Fall 2026", startDate: new Date("2026-09-01"), endDate: new Date("2026-12-15") } });
  return prisma.recruitmentCycle.create({ data: { track: "VOLUNTEER", termId: term.id, title: "T", publicSlug: "t", departments: [], acceptsRenewals: false, createdById: person.id } });
}

describe("materializeTemplate", () => {
  it("writes sections and fields with explicit keys, order, and JSON options", async () => {
    const cycle = await bareCycle();
    const sections: TemplateSection[] = [
      { title: "Personal details", order: 0, appliesTo: "NEW", departmentCode: null, purpose: "APPLICATION",
        fields: [
          { key: "email", label: "Yale email", type: "EMAIL", required: true, order: 0 },
          { key: "spanish_proficiency", label: "Spanish", type: "SINGLE_SELECT", required: true, order: 1, options: [{ label: "None", value: "none" }] },
        ] },
      { title: "MDIC department questions", order: 1, appliesTo: "NEW", departmentCode: "MDIC", purpose: "APPLICATION", fields: [] },
    ];
    await prisma.$transaction((tx) => materializeTemplate(tx, cycle.id, sections));

    const dbSections = await prisma.formSection.findMany({ where: { cycleId: cycle.id }, orderBy: { order: "asc" }, include: { fields: { orderBy: { order: "asc" } } } });
    expect(dbSections.map((s) => s.title)).toEqual(["Personal details", "MDIC department questions"]);
    expect(dbSections[1].departmentCode).toBe("MDIC");
    expect(dbSections[0].fields.map((f) => f.key)).toEqual(["email", "spanish_proficiency"]);
    expect(dbSections[0].fields[1].options).toEqual([{ label: "None", value: "none" }]);
  });
});
