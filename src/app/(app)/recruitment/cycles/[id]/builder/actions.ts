"use server";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requirePermission } from "@/platform/auth/session";
import {
  addSection, deleteSection,
  addField, updateField, deleteField, FormEditError,
} from "@/modules/recruitment/services/form-builder";
import type { ApplicantScope, FieldType } from "@prisma/client";

function bouncePath(cycleId: string, error?: string) {
  return `/recruitment/cycles/${cycleId}/builder${error ? `?error=${encodeURIComponent(error)}` : ""}`;
}

export async function addSectionAction(cycleId: string, formData: FormData) {
  await requirePermission("recruitment.manage_cycles");
  const departmentCode = String(formData.get("departmentCode") ?? "").trim() || null;
  try {
    await addSection(cycleId, {
      title: String(formData.get("title") ?? "Section"),
      appliesTo: String(formData.get("appliesTo") ?? "BOTH") as ApplicantScope,
      departmentCode,
    });
  } catch (err) {
    if (err instanceof FormEditError) redirect(bouncePath(cycleId, err.message));
    throw err;
  }
  revalidatePath(bouncePath(cycleId));
}

export async function addFieldAction(cycleId: string, sectionId: string, formData: FormData) {
  await requirePermission("recruitment.manage_cycles");
  const options = String(formData.get("options") ?? "").split("\n").map((s) => s.trim()).filter(Boolean).map((v) => ({ value: v, label: v }));
  try {
    await addField(sectionId, {
      label: String(formData.get("label") ?? "Field"),
      type: String(formData.get("type") ?? "SHORT_TEXT") as FieldType,
      required: formData.get("required") === "on",
      options: options.length ? options : undefined,
    });
  } catch (err) {
    if (err instanceof FormEditError) redirect(bouncePath(cycleId, err.message));
    throw err;
  }
  revalidatePath(bouncePath(cycleId));
}

export async function updateFieldAction(cycleId: string, fieldId: string, formData: FormData) {
  await requirePermission("recruitment.manage_cycles");
  try {
    await updateField(fieldId, {
      label: String(formData.get("label") ?? undefined) || undefined,
      required: formData.get("required") === "on" ? true : undefined,
    });
  } catch (err) {
    if (err instanceof FormEditError) redirect(bouncePath(cycleId, err.message));
    throw err;
  }
  revalidatePath(bouncePath(cycleId));
}

export async function deleteFieldAction(cycleId: string, fieldId: string) {
  await requirePermission("recruitment.manage_cycles");
  try {
    await deleteField(fieldId);
  } catch (err) {
    if (err instanceof FormEditError) redirect(bouncePath(cycleId, err.message));
    throw err;
  }
  revalidatePath(bouncePath(cycleId));
}

export async function deleteSectionAction(cycleId: string, sectionId: string) {
  await requirePermission("recruitment.manage_cycles");
  try {
    await deleteSection(sectionId);
  } catch (err) {
    if (err instanceof FormEditError) redirect(bouncePath(cycleId, err.message));
    throw err;
  }
  revalidatePath(bouncePath(cycleId));
}

export async function addQuizSectionAction(cycleId: string, formData: FormData) {
  await requirePermission("recruitment.manage_cycles");
  const title = String(formData.get("title") ?? "").trim() || "Quiz";
  try {
    await addSection(cycleId, { title, appliesTo: "BOTH", departmentCode: null, purpose: "QUIZ" });
  } catch (err) {
    if (err instanceof FormEditError) redirect(`/recruitment/cycles/${cycleId}/builder/quiz?error=${encodeURIComponent(err.message)}`);
    throw err;
  }
  revalidatePath(`/recruitment/cycles/${cycleId}/builder/quiz`);
}

export async function addQuizQuestionAction(cycleId: string, sectionId: string, formData: FormData) {
  await requirePermission("recruitment.manage_cycles");
  const label = String(formData.get("label") ?? "").trim();
  const values = formData.getAll("optionValue").map(String);
  const labels = formData.getAll("optionLabel").map(String);
  const options = values.map((v, i) => ({ value: v, label: labels[i] ?? v })).filter((o) => o.value.length > 0);
  const correctValue = String(formData.get("correctValue") ?? "") || null;
  if (!label || options.length < 2) {
    redirect(`/recruitment/cycles/${cycleId}/builder/quiz?error=${encodeURIComponent("A question needs a label and at least two options.")}`);
  }
  try {
    await addField(sectionId, { label, type: "SINGLE_SELECT", required: true, options, correctValue });
  } catch (err) {
    if (err instanceof FormEditError) redirect(`/recruitment/cycles/${cycleId}/builder/quiz?error=${encodeURIComponent(err.message)}`);
    throw err;
  }
  revalidatePath(`/recruitment/cycles/${cycleId}/builder/quiz`);
}

export async function setCorrectAnswerAction(cycleId: string, fieldId: string, formData: FormData) {
  await requirePermission("recruitment.manage_cycles");
  const correctValue = String(formData.get("correctValue") ?? "") || null;
  await updateField(fieldId, { correctValue });
  revalidatePath(`/recruitment/cycles/${cycleId}/builder/quiz`);
}
