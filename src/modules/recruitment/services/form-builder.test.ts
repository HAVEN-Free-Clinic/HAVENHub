import { afterEach, beforeEach, expect, it } from "vitest";
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

it("blocks adding a required field after publish but allows an optional one", async () => {
  const { person, cycle } = await draftCycle();
  const section = await addSection(cycle.id, { title: "Essays", appliesTo: "BOTH", departmentCode: null });
  await publishCycle(cycle.id, person.id);

  await expect(
    addField(section.id, { label: "Late required", type: "SHORT_TEXT", required: true })
  ).rejects.toBeInstanceOf(FormEditError);

  const optional = await addField(section.id, { label: "Late optional", type: "SHORT_TEXT", required: false });
  expect(optional.required).toBe(false);
});

it("creates a QUIZ section and a graded question with a correctValue", async () => {
  const term = await prisma.term.create({ data: { code: "SU26", name: "S", startDate: new Date(), endDate: new Date(), status: "ACTIVE" } });
  const srr = await prisma.person.create({ data: { name: "SRR", status: "ACTIVE" } });
  const cycle = await prisma.recruitmentCycle.create({ data: { track: "VOLUNTEER", termId: term.id, title: "C", publicSlug: "c", departments: [], createdById: srr.id, status: "DRAFT" } });

  const section = await addSection(cycle.id, { title: "Quiz", appliesTo: "BOTH", departmentCode: null, purpose: "QUIZ" });
  expect(section.purpose).toBe("QUIZ");
  const field = await addField(section.id, { label: "Capital of France?", type: "SINGLE_SELECT", required: true, options: [{ value: "paris", label: "Paris" }, { value: "lyon", label: "Lyon" }], correctValue: "paris" });
  expect(field.correctValue).toBe("paris");

  await prisma.recruitmentCycle.update({ where: { id: cycle.id }, data: { status: "OPEN" } });
  const updated = await updateField(field.id, { correctValue: "lyon" });
  expect(updated.correctValue).toBe("lyon");
});
