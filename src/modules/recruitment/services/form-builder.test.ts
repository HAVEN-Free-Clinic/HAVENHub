import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetDb } from "@/platform/test/db";
import { prisma } from "@/platform/db";
import { createCycle, publishCycle } from "./cycles";
import {
  addSection, addField, updateField, deleteField, FormEditError,
} from "./form-builder";

async function draftCycle(acceptsRenewals = false) {
  const person = await prisma.person.create({ data: { name: "Lead", status: "ACTIVE" } });
  const term = await prisma.term.create({ data: { code: "FA26", name: "Fall 2026", startDate: new Date(), endDate: new Date() } });
  const cycle = await createCycle({ track: "VOLUNTEER", termId: term.id, title: "V", publicSlug: "v", departments: ["SRHD"], acceptsRenewals, createdById: person.id });
  return { person, cycle };
}

beforeEach(async () => { await resetDb(); });
afterEach(async () => { await resetDb(); });

it("adds a section and a field with a generated unique key", async () => {
  const { cycle } = await draftCycle();
  const section = await addSection(cycle.id, { title: "Essays", appliesTo: "NEW", departmentCode: null });
  const f1 = await addField(section.id, { label: "Why HAVEN?", type: "LONG_TEXT", required: true });
  const f2 = await addField(section.id, { label: "Why HAVEN?", type: "LONG_TEXT", required: false });
  expect(f1.key).toBe("why_haven");
  expect(f2.key).toBe("why_haven_2");
  expect(f1.cycleId).toBe(cycle.id);
});

it("allows safe edits after OPEN but blocks structural ones", async () => {
  const { person, cycle } = await draftCycle();
  const section = await addSection(cycle.id, { title: "Essays", appliesTo: "BOTH", departmentCode: null });
  const field = await addField(section.id, { label: "Bio", type: "SHORT_TEXT", required: false });
  await publishCycle(cycle.id, person.id);

  const relabeled = await updateField(field.id, { label: "Short bio" });
  expect(relabeled.label).toBe("Short bio");

  await expect(updateField(field.id, { type: "NUMBER" })).rejects.toBeInstanceOf(FormEditError);
  await expect(updateField(field.id, { required: true })).rejects.toBeInstanceOf(FormEditError);
  await expect(deleteField(field.id)).rejects.toBeInstanceOf(FormEditError);
});
