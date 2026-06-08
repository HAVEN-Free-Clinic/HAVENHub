"use server";
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
  await addSection(cycleId, {
    title: String(formData.get("title") ?? "Section"),
    appliesTo: (String(formData.get("appliesTo") ?? "BOTH") as ApplicantScope),
    departmentCode,
  });
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
    if (err instanceof FormEditError) revalidatePath(bouncePath(cycleId, err.message));
    else throw err;
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
    if (err instanceof FormEditError) revalidatePath(bouncePath(cycleId, err.message));
    else throw err;
  }
  revalidatePath(bouncePath(cycleId));
}

export async function deleteFieldAction(cycleId: string, fieldId: string) {
  await requirePermission("recruitment.manage_cycles");
  try { await deleteField(fieldId); }
  catch (err) { if (err instanceof FormEditError) revalidatePath(bouncePath(cycleId, err.message)); else throw err; }
  revalidatePath(bouncePath(cycleId));
}

export async function deleteSectionAction(cycleId: string, sectionId: string) {
  await requirePermission("recruitment.manage_cycles");
  try { await deleteSection(sectionId); }
  catch (err) { if (err instanceof FormEditError) revalidatePath(bouncePath(cycleId, err.message)); else throw err; }
  revalidatePath(bouncePath(cycleId));
}
