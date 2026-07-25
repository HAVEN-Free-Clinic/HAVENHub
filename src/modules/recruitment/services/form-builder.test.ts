import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetDb } from "@/platform/test/db";
import { prisma } from "@/platform/db";
import { createCycle, publishCycle, closeCycle, archiveCycle } from "./cycles";
import {
  addSection, addField, updateField, deleteField, reorderSections, reorderFields, FormEditError,
} from "./form-builder";

async function draftCycle(acceptsRenewals = false) {
  const person = await prisma.person.create({ data: { name: "Lead", status: "ACTIVE" } });
  const term = await prisma.term.create({ data: { code: "FA26", name: "Fall 2026", startDate: new Date(), endDate: new Date() } });
  const cycle = await createCycle({ track: "VOLUNTEER", termId: term.id, title: "V", publicSlug: "v", departments: ["SRHD"], acceptsRenewals, createdById: person.id });
  return { person, cycle };
}

beforeEach(async () => { await resetDb(); });
afterEach(async () => { await resetDb(); });

describe("reorder splices the visible subset into the full set (#104)", () => {
  it("reorderSections keeps a hidden (unsupplied) section at a distinct, non-colliding order", async () => {
    const { cycle } = await draftCycle();
    const a = await addSection(cycle.id, { title: "A", appliesTo: "BOTH", departmentCode: null }); // order 0
    const b = await addSection(cycle.id, { title: "B hidden", appliesTo: "BOTH", departmentCode: null }); // order 1
    const c = await addSection(cycle.id, { title: "C", appliesTo: "BOTH", departmentCode: null }); // order 2

    // The builder hides B (e.g. the availability section when the clinic calendar
    // is empty), so the drag supplies only the visible ids -- C moved above A.
    await reorderSections(cycle.id, [c.id, a.id]);

    const after = await prisma.formSection.findMany({ where: { cycleId: cycle.id }, select: { id: true, order: true } });
    // No collision: every section (including the hidden B) has a distinct order.
    expect(new Set(after.map((s) => s.order)).size).toBe(after.length);
    const orderOf = new Map(after.map((s) => [s.id, s.order]));
    // Visible sections took their new relative order (C above A), and the hidden B
    // stays anchored between them (its original slot), not left at a stale/colliding
    // order. c < b < a captures both.
    expect(orderOf.get(c.id)!).toBeLessThan(orderOf.get(b.id)!);
    expect(orderOf.get(b.id)!).toBeLessThan(orderOf.get(a.id)!);
  });

  it("reorderFields keeps a hidden (unsupplied) field at a distinct, non-colliding order", async () => {
    const { cycle } = await draftCycle();
    const section = await addSection(cycle.id, { title: "S", appliesTo: "BOTH", departmentCode: null });
    const f1 = await addField(section.id, { label: "F1", type: "SHORT_TEXT", required: false }); // order 0
    const f2 = await addField(section.id, { label: "F2 hidden", type: "SHORT_TEXT", required: false }); // order 1
    const f3 = await addField(section.id, { label: "F3", type: "SHORT_TEXT", required: false }); // order 2

    await reorderFields(section.id, [f3.id, f1.id]); // f2 hidden

    const after = await prisma.formField.findMany({ where: { sectionId: section.id }, select: { id: true, order: true } });
    expect(new Set(after.map((f) => f.order)).size).toBe(after.length);
    const orderOf = new Map(after.map((f) => [f.id, f.order]));
    // F3 above F1 (the new visible order), hidden F2 anchored between them.
    expect(orderOf.get(f3.id)!).toBeLessThan(orderOf.get(f2.id)!);
    expect(orderOf.get(f2.id)!).toBeLessThan(orderOf.get(f1.id)!);
  });
});

it("adds a section and a field with a generated unique key", async () => {
  const { cycle } = await draftCycle();
  const section = await addSection(cycle.id, { title: "Essays", appliesTo: "NEW", departmentCode: null });
  const f1 = await addField(section.id, { label: "Why HAVEN?", type: "LONG_TEXT", required: true });
  const f2 = await addField(section.id, { label: "Why HAVEN?", type: "LONG_TEXT", required: false });
  expect(f1.key).toBe("why_haven");
  expect(f2.key).toBe("why_haven_2");
  expect(f1.cycleId).toBe(cycle.id);
});

// Directors must be able to edit a form after it opens, not just in DRAFT --
// the only edit-locked state is ARCHIVED (the terminal, retired state).

it("allows both safe and structural edits on an OPEN cycle", async () => {
  const { person, cycle } = await draftCycle();
  const section = await addSection(cycle.id, { title: "Essays", appliesTo: "BOTH", departmentCode: null });
  const field = await addField(section.id, { label: "Bio", type: "SHORT_TEXT", required: false });
  await publishCycle(cycle.id, person.id);

  const relabeled = await updateField(field.id, { label: "Short bio" });
  expect(relabeled.label).toBe("Short bio");

  const retyped = await updateField(field.id, { type: "NUMBER" });
  expect(retyped.type).toBe("NUMBER");

  const required = await updateField(field.id, { required: true });
  expect(required.required).toBe(true);

  await deleteField(field.id);
  expect(await prisma.formField.findUnique({ where: { id: field.id } })).toBeNull();
});

it("blocks structural edits once a cycle is archived, but still allows safe ones", async () => {
  const { person, cycle } = await draftCycle();
  const section = await addSection(cycle.id, { title: "Essays", appliesTo: "BOTH", departmentCode: null });
  const field = await addField(section.id, { label: "Bio", type: "SHORT_TEXT", required: false });
  await publishCycle(cycle.id, person.id);
  await closeCycle(cycle.id, person.id);
  await archiveCycle(cycle.id, person.id);

  await expect(updateField(field.id, { type: "NUMBER" })).rejects.toBeInstanceOf(FormEditError);
  await expect(updateField(field.id, { required: true })).rejects.toBeInstanceOf(FormEditError);
  await expect(deleteField(field.id)).rejects.toBeInstanceOf(FormEditError);
  await expect(
    addField(section.id, { label: "Too late", type: "SHORT_TEXT", required: true })
  ).rejects.toBeInstanceOf(FormEditError);

  const relabeled = await updateField(field.id, { label: "Short bio" });
  expect(relabeled.label).toBe("Short bio");
});

it("allows adding a required field on an OPEN cycle (and an optional one too)", async () => {
  const { person, cycle } = await draftCycle();
  const section = await addSection(cycle.id, { title: "Essays", appliesTo: "BOTH", departmentCode: null });
  await publishCycle(cycle.id, person.id);

  const required = await addField(section.id, { label: "Late required", type: "SHORT_TEXT", required: true });
  expect(required.required).toBe(true);

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

it("allows adding and deleting quiz questions on an OPEN cycle (quiz sections never affect applications)", async () => {
  const term = await prisma.term.create({ data: { code: "SU26", name: "S", startDate: new Date(), endDate: new Date(), status: "ACTIVE" } });
  const srr = await prisma.person.create({ data: { name: "SRR", status: "ACTIVE" } });
  const cycle = await prisma.recruitmentCycle.create({ data: { track: "VOLUNTEER", termId: term.id, title: "C", publicSlug: "c-open-quiz", departments: [], createdById: srr.id, status: "OPEN" } });
  const quiz = await addSection(cycle.id, { title: "Quiz", appliesTo: "BOTH", departmentCode: null, purpose: "QUIZ" });
  // Adding a required quiz question on an OPEN cycle must succeed (it cannot invalidate applicant answers).
  const q = await addField(quiz.id, { label: "Q1", type: "SINGLE_SELECT", required: true, options: [{ value: "a", label: "A" }, { value: "b", label: "B" }], correctValue: "a" });
  expect(q.id).toBeTruthy();
  // Deleting a quiz question on an OPEN cycle must also succeed.
  await deleteField(q.id);
  expect(await prisma.formField.findUnique({ where: { id: q.id } })).toBeNull();
});

it("allows adding a required APPLICATION field on an OPEN cycle", async () => {
  const term = await prisma.term.create({ data: { code: "SU26", name: "S", startDate: new Date(), endDate: new Date(), status: "ACTIVE" } });
  const srr = await prisma.person.create({ data: { name: "SRR", status: "ACTIVE" } });
  const cycle = await prisma.recruitmentCycle.create({ data: { track: "VOLUNTEER", termId: term.id, title: "C", publicSlug: "c-open-app", departments: [], createdById: srr.id, status: "OPEN" } });
  const sec = await addSection(cycle.id, { title: "More", appliesTo: "BOTH", departmentCode: null });
  const added = await addField(sec.id, { label: "Extra", type: "SHORT_TEXT", required: true });
  expect(added.required).toBe(true);
});

it("blocks adding a required APPLICATION field on an ARCHIVED cycle", async () => {
  const term = await prisma.term.create({ data: { code: "SU26", name: "S", startDate: new Date(), endDate: new Date(), status: "ACTIVE" } });
  const srr = await prisma.person.create({ data: { name: "SRR", status: "ACTIVE" } });
  const cycle = await prisma.recruitmentCycle.create({ data: { track: "VOLUNTEER", termId: term.id, title: "C", publicSlug: "c-archived-app", departments: [], createdById: srr.id, status: "ARCHIVED" } });
  const sec = await addSection(cycle.id, { title: "More", appliesTo: "BOTH", departmentCode: null });
  await expect(addField(sec.id, { label: "Extra", type: "SHORT_TEXT", required: true })).rejects.toBeInstanceOf(FormEditError);
});

describe("visibleWhen persistence", () => {
  async function withGateAndDetail() {
    const { person, cycle } = await draftCycle();
    const section = await addSection(cycle.id, { title: "Info", appliesTo: "BOTH", departmentCode: null });
    const gate = await addField(section.id, {
      label: "Do you speak other languages?", type: "SINGLE_SELECT", required: false,
      options: [{ value: "yes", label: "Yes" }, { value: "no", label: "No" }],
    });
    const detail = await addField(section.id, { label: "Which languages?", type: "SHORT_TEXT", required: false });
    return { person, cycle, gate, detail };
  }

  it("persists a valid visibleWhen condition", async () => {
    const { gate, detail } = await withGateAndDetail();
    const updated = await updateField(detail.id, { visibleWhen: { field: gate.key, op: "is", value: "yes" } });
    expect(updated.visibleWhen).toEqual({ field: gate.key, op: "is", value: "yes" });
  });

  it("clears visibleWhen when set to null", async () => {
    const { gate, detail } = await withGateAndDetail();
    await updateField(detail.id, { visibleWhen: { field: gate.key, op: "is", value: "yes" } });
    const cleared = await updateField(detail.id, { visibleWhen: null });
    expect(cleared.visibleWhen).toBeNull();
  });

  it("rejects an invalid visibleWhen condition without persisting it", async () => {
    const { detail } = await withGateAndDetail();
    await expect(updateField(detail.id, { visibleWhen: { op: "bogus" } })).rejects.toBeInstanceOf(FormEditError);
    const reloaded = await prisma.formField.findUniqueOrThrow({ where: { id: detail.id } });
    expect(reloaded.visibleWhen).toBeNull();
  });

  it("marks a visibleWhen change as structural: allowed once OPEN, blocked once archived", async () => {
    const { person, cycle, gate, detail } = await withGateAndDetail();
    await publishCycle(cycle.id, person.id);

    const updated = await updateField(detail.id, { visibleWhen: { field: gate.key, op: "is", value: "yes" } });
    expect(updated.visibleWhen).toEqual({ field: gate.key, op: "is", value: "yes" });

    await closeCycle(cycle.id, person.id);
    await archiveCycle(cycle.id, person.id);
    await expect(
      updateField(detail.id, { visibleWhen: { field: gate.key, op: "is", value: "no" } })
    ).rejects.toBeInstanceOf(FormEditError);
  });
});
