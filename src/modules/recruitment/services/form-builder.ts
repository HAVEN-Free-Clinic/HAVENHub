import type { ApplicantScope, FieldType, FormField, FormSection } from "@prisma/client";
import { prisma } from "@/platform/db";
import { uniqueKey } from "../engine/field-key";

export class FormEditError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FormEditError";
  }
}

async function assertCycleEditable(cycleId: string, structural: boolean): Promise<void> {
  const cycle = await prisma.recruitmentCycle.findUnique({ where: { id: cycleId } });
  if (!cycle) throw new FormEditError("Cycle not found.");
  if (structural && cycle.status !== "DRAFT") {
    throw new FormEditError("This cycle is published; that change would invalidate existing answers.");
  }
}

export async function addSection(
  cycleId: string,
  input: { title: string; appliesTo: ApplicantScope; departmentCode: string | null; description?: string }
): Promise<FormSection> {
  await assertCycleEditable(cycleId, false);
  const count = await prisma.formSection.count({ where: { cycleId } });
  return prisma.formSection.create({
    data: { cycleId, title: input.title, description: input.description ?? null, appliesTo: input.appliesTo, departmentCode: input.departmentCode, order: count },
  });
}

export async function addField(
  sectionId: string,
  input: { label: string; type: FieldType; required: boolean; helpText?: string; options?: unknown; validation?: unknown }
): Promise<FormField> {
  const section = await prisma.formSection.findUnique({ where: { id: sectionId } });
  if (!section) throw new FormEditError("Section not found.");
  await assertCycleEditable(section.cycleId, input.required === true);

  const existing = await prisma.formField.findMany({ where: { cycleId: section.cycleId }, select: { key: true } });
  const key = uniqueKey(input.label, existing.map((f) => f.key));
  const count = await prisma.formField.count({ where: { sectionId } });

  return prisma.formField.create({
    data: {
      sectionId, cycleId: section.cycleId, key, label: input.label, type: input.type,
      required: input.required, helpText: input.helpText ?? null,
      options: (input.options ?? undefined) as never, validation: (input.validation ?? undefined) as never,
      order: count,
    },
  });
}

export async function updateField(
  fieldId: string,
  patch: { label?: string; helpText?: string; type?: FieldType; required?: boolean; options?: unknown; validation?: unknown }
): Promise<FormField> {
  const field = await prisma.formField.findUnique({ where: { id: fieldId } });
  if (!field) throw new FormEditError("Field not found.");

  const structural =
    (patch.type !== undefined && patch.type !== field.type) ||
    (patch.required === true && field.required === false);
  await assertCycleEditable(field.cycleId, structural);

  return prisma.formField.update({
    where: { id: fieldId },
    data: {
      label: patch.label ?? undefined,
      helpText: patch.helpText ?? undefined,
      type: patch.type ?? undefined,
      required: patch.required ?? undefined,
      options: patch.options === undefined ? undefined : (patch.options as never),
      validation: patch.validation === undefined ? undefined : (patch.validation as never),
    },
  });
}

export async function deleteField(fieldId: string): Promise<void> {
  const field = await prisma.formField.findUnique({ where: { id: fieldId } });
  if (!field) throw new FormEditError("Field not found.");
  await assertCycleEditable(field.cycleId, true);
  await prisma.formField.delete({ where: { id: fieldId } });
}

export async function reorderFields(sectionId: string, orderedFieldIds: string[]): Promise<void> {
  const section = await prisma.formSection.findUnique({ where: { id: sectionId } });
  if (!section) throw new FormEditError("Section not found.");
  await assertCycleEditable(section.cycleId, false);
  // Every supplied id must belong to this section; reject unknown/foreign ids.
  const owned = await prisma.formField.count({ where: { id: { in: orderedFieldIds }, sectionId } });
  if (owned !== orderedFieldIds.length) throw new FormEditError("Invalid field ids for this section.");
  await prisma.$transaction(
    orderedFieldIds.map((id, index) =>
      prisma.formField.updateMany({ where: { id, sectionId }, data: { order: index } })
    )
  );
}

export async function reorderSections(cycleId: string, orderedSectionIds: string[]): Promise<void> {
  await assertCycleEditable(cycleId, false);
  // Every supplied id must belong to this cycle; reject unknown/foreign ids.
  const owned = await prisma.formSection.count({ where: { id: { in: orderedSectionIds }, cycleId } });
  if (owned !== orderedSectionIds.length) throw new FormEditError("Invalid section ids for this cycle.");
  await prisma.$transaction(
    orderedSectionIds.map((id, index) =>
      prisma.formSection.updateMany({ where: { id, cycleId }, data: { order: index } })
    )
  );
}

export async function updateSection(
  sectionId: string,
  patch: { title?: string; description?: string; appliesTo?: ApplicantScope; departmentCode?: string | null }
): Promise<FormSection> {
  const section = await prisma.formSection.findUnique({ where: { id: sectionId } });
  if (!section) throw new FormEditError("Section not found.");
  const structural =
    (patch.appliesTo !== undefined && patch.appliesTo !== section.appliesTo) ||
    (patch.departmentCode !== undefined && patch.departmentCode !== section.departmentCode);
  await assertCycleEditable(section.cycleId, structural);
  return prisma.formSection.update({
    where: { id: sectionId },
    data: {
      title: patch.title ?? undefined,
      description: patch.description ?? undefined,
      appliesTo: patch.appliesTo ?? undefined,
      departmentCode: patch.departmentCode === undefined ? undefined : patch.departmentCode,
    },
  });
}

export async function deleteSection(sectionId: string): Promise<void> {
  const section = await prisma.formSection.findUnique({ where: { id: sectionId } });
  if (!section) throw new FormEditError("Section not found.");
  await assertCycleEditable(section.cycleId, true);
  await prisma.formSection.delete({ where: { id: sectionId } });
}
