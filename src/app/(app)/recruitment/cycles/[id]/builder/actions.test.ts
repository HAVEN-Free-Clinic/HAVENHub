// src/app/(app)/recruitment/cycles/[id]/builder/actions.test.ts
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("@/platform/auth/session", () => ({
  requirePermission: vi.fn().mockResolvedValue({ personId: "p1" }),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { resetDb } from "@/platform/test/db";
import { prisma } from "@/platform/db";
import { createCycle, publishCycle } from "@/modules/recruitment/services/cycles";
import {
  addSectionAction, updateSectionAction, reorderSectionsAction,
  addFieldAction, updateFieldAction, duplicateFieldAction, reorderFieldsAction,
} from "./actions";

async function draftCycle() {
  const person = await prisma.person.create({ data: { name: "Lead", status: "ACTIVE" } });
  const term = await prisma.term.create({ data: { code: "FA26", name: "Fall 2026", startDate: new Date(), endDate: new Date() } });
  return createCycle({ track: "VOLUNTEER", termId: term.id, title: "V", publicSlug: "v", departments: ["SRHD"], acceptsRenewals: false, createdById: person.id });
}

beforeEach(async () => { await resetDb(); });
afterEach(async () => { await resetDb(); });

it("adds a field with the type's friendly default label", async () => {
  const cycle = await draftCycle();
  const r = await addSectionAction(cycle.id, { title: "About", appliesTo: "BOTH", departmentCode: null });
  expect(r.ok).toBe(true);
  // There will be 2 sections: the auto-created identity section + "About".
  const section = await prisma.formSection.findFirstOrThrow({ where: { cycleId: cycle.id, title: "About" } });
  const add = await addFieldAction(cycle.id, section.id, { type: "SHORT_TEXT" });
  expect(add.ok).toBe(true);
  const field = await prisma.formField.findFirstOrThrow({ where: { sectionId: section.id } });
  expect(field.label).toBe("Short text");
});

it("updates a section's safe fields", async () => {
  const cycle = await draftCycle();
  await addSectionAction(cycle.id, { title: "About", appliesTo: "BOTH", departmentCode: null });
  const section = await prisma.formSection.findFirstOrThrow({ where: { cycleId: cycle.id, title: "About" } });
  const r = await updateSectionAction(cycle.id, section.id, { title: "About you", description: "Tell us." });
  expect(r.ok).toBe(true);
  const after = await prisma.formSection.findUniqueOrThrow({ where: { id: section.id } });
  expect(after.title).toBe("About you");
  expect(after.description).toBe("Tell us.");
});

it("reorders fields and persists order", async () => {
  const cycle = await draftCycle();
  await addSectionAction(cycle.id, { title: "About", appliesTo: "BOTH", departmentCode: null });
  const section = await prisma.formSection.findFirstOrThrow({ where: { cycleId: cycle.id, title: "About" } });
  await addFieldAction(cycle.id, section.id, { type: "SHORT_TEXT" });
  await addFieldAction(cycle.id, section.id, { type: "EMAIL" });
  const fields = await prisma.formField.findMany({ where: { sectionId: section.id }, orderBy: { order: "asc" } });
  const reversed = [fields[1].id, fields[0].id];
  const r = await reorderFieldsAction(cycle.id, section.id, reversed);
  expect(r.ok).toBe(true);
  const after = await prisma.formField.findMany({ where: { sectionId: section.id }, orderBy: { order: "asc" } });
  expect(after.map((f) => f.id)).toEqual(reversed);
});

it("duplicates a field into the same section", async () => {
  const cycle = await draftCycle();
  await addSectionAction(cycle.id, { title: "About", appliesTo: "BOTH", departmentCode: null });
  const section = await prisma.formSection.findFirstOrThrow({ where: { cycleId: cycle.id, title: "About" } });
  await addFieldAction(cycle.id, section.id, { type: "SHORT_TEXT" });
  const field = await prisma.formField.findFirstOrThrow({ where: { sectionId: section.id } });
  const r = await duplicateFieldAction(cycle.id, field.id);
  expect(r.ok).toBe(true);
  const count = await prisma.formField.count({ where: { sectionId: section.id } });
  expect(count).toBe(2);
});

it("rejects a structural type change on a published cycle as an inline error", async () => {
  const cycle = await draftCycle();
  // Add a non-identity field in a new section for testing the type-change guard.
  await addSectionAction(cycle.id, { title: "About", appliesTo: "BOTH", departmentCode: null });
  const section = await prisma.formSection.findFirstOrThrow({ where: { cycleId: cycle.id, title: "About" } });
  await addFieldAction(cycle.id, section.id, { type: "SHORT_TEXT" });
  const field = await prisma.formField.findFirstOrThrow({ where: { sectionId: section.id } });
  // Publish the cycle (identity fields were pre-created by createCycle).
  const actor = await prisma.person.findFirstOrThrow();
  await publishCycle(cycle.id, actor.id);
  const r = await updateFieldAction(cycle.id, field.id, { type: "NUMBER" });
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.error).toMatch(/published/i);
  const safe = await updateFieldAction(cycle.id, field.id, { label: "Renamed" });
  expect(safe.ok).toBe(true);
});

it("reorders sections and persists order", async () => {
  const cycle = await draftCycle();
  await addSectionAction(cycle.id, { title: "Alpha", appliesTo: "BOTH", departmentCode: null });
  await addSectionAction(cycle.id, { title: "Beta", appliesTo: "BOTH", departmentCode: null });
  const sections = await prisma.formSection.findMany({
    where: { cycleId: cycle.id, title: { in: ["Alpha", "Beta"] } },
    orderBy: { order: "asc" },
  });
  const first = sections[0];
  const second = sections[1];
  const reversed = [second.id, first.id];
  const r = await reorderSectionsAction(cycle.id, reversed);
  expect(r.ok).toBe(true);
  const after = await prisma.formSection.findMany({
    where: { cycleId: cycle.id, title: { in: ["Alpha", "Beta"] } },
    orderBy: { order: "asc" },
  });
  expect(after.map((s) => s.id)).toEqual(reversed);
});
