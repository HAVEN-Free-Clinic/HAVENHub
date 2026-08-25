"use server";
import { revalidatePath } from "next/cache";
import { requirePermission } from "@/platform/auth/session";
import {
  addSection, updateSection, deleteSection, reorderSections,
  addField, updateField, deleteField, reorderFields, FormEditError,
} from "@/modules/recruitment/services/form-builder";
import { FIELD_TYPE_META } from "@/modules/recruitment/engine/field-types";
import { prisma } from "@/platform/db";
import type { ApplicantScope, FieldType } from "@prisma/client";

export type ActionResult = { ok: true } | { ok: false; error: string };

function builderPath(cycleId: string) {
  return `/recruitment/cycles/${cycleId}/builder`;
}
function quizPath(cycleId: string) {
  return `/recruitment/cycles/${cycleId}/builder/quiz`;
}

async function run(cycleId: string, fn: () => Promise<unknown>, paths: string[] = []): Promise<ActionResult> {
  await requirePermission("recruitment.manage_cycles");
  try {
    await fn();
  } catch (err) {
    if (err instanceof FormEditError) return { ok: false, error: err.message };
    throw err;
  }
  for (const p of paths.length ? paths : [builderPath(cycleId)]) revalidatePath(p);
  return { ok: true };
}

export async function addSectionAction(
  cycleId: string,
  input: { title: string; appliesTo: ApplicantScope; departmentCode: string | null; purpose?: "APPLICATION" | "QUIZ" },
): Promise<ActionResult> {
  const paths = input.purpose === "QUIZ" ? [quizPath(cycleId)] : [builderPath(cycleId)];
  return run(cycleId, () => addSection(cycleId, input), paths);
}

export async function updateSectionAction(
  cycleId: string,
  sectionId: string,
  patch: { title?: string; description?: string; appliesTo?: ApplicantScope; departmentCode?: string | null },
): Promise<ActionResult> {
  return run(cycleId, () => updateSection(sectionId, patch), [builderPath(cycleId), quizPath(cycleId)]);
}

export async function deleteSectionAction(cycleId: string, sectionId: string): Promise<ActionResult> {
  return run(cycleId, () => deleteSection(sectionId), [builderPath(cycleId), quizPath(cycleId)]);
}

export async function reorderSectionsAction(cycleId: string, orderedSectionIds: string[]): Promise<ActionResult> {
  return run(cycleId, () => reorderSections(cycleId, orderedSectionIds), [builderPath(cycleId), quizPath(cycleId)]);
}

export async function addFieldAction(
  cycleId: string,
  sectionId: string,
  input: { type: FieldType; visibleWhen?: unknown | null },
): Promise<ActionResult> {
  return run(cycleId, () =>
    addField(sectionId, { label: FIELD_TYPE_META[input.type].label, type: input.type, required: false, visibleWhen: input.visibleWhen }),
  );
}

export async function updateFieldAction(
  cycleId: string,
  fieldId: string,
  patch: {
    label?: string; helpText?: string; required?: boolean; type?: FieldType;
    options?: { value: string; label: string }[]; validation?: Record<string, unknown> | null; correctValue?: string | null;
    visibleWhen?: unknown | null;
  },
): Promise<ActionResult> {
  return run(cycleId, () => updateField(fieldId, patch), [builderPath(cycleId), quizPath(cycleId)]);
}

export async function duplicateFieldAction(cycleId: string, fieldId: string): Promise<ActionResult> {
  return run(cycleId, async () => {
    const field = await prisma.formField.findUnique({ where: { id: fieldId } });
    if (!field) throw new FormEditError("Field not found.");
    await addField(field.sectionId, {
      // A notice's label is its heading -- content the applicant reads, and
      // often empty -- so the "(copy)" marker that disambiguates two questions
      // in the builder would instead ship as a visible " (copy)" on the form.
      label: field.type === "NOTICE" ? field.label : `${field.label} (copy)`,
      type: field.type,
      required: field.required,
      helpText: field.helpText ?? undefined,
      options: field.options ?? undefined,
      validation: field.validation ?? undefined,
      correctValue: field.correctValue,
      visibleWhen: field.visibleWhen ?? undefined,
    });
  });
}

export async function deleteFieldAction(cycleId: string, fieldId: string): Promise<ActionResult> {
  return run(cycleId, () => deleteField(fieldId), [builderPath(cycleId), quizPath(cycleId)]);
}

export async function reorderFieldsAction(cycleId: string, sectionId: string, orderedFieldIds: string[]): Promise<ActionResult> {
  return run(cycleId, () => reorderFields(sectionId, orderedFieldIds), [builderPath(cycleId), quizPath(cycleId)]);
}
