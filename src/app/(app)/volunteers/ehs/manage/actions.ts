"use server";

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/platform/auth/session";
import { runAction } from "@/platform/actions";
import {
  createTraining,
  updateTraining,
  setTrainingDepartments,
} from "@/platform/ehs/services/trainings";
import { EhsValidationError } from "@/platform/ehs/services/errors";

export async function createTrainingAction(formData: FormData): Promise<void> {
  const person = await requirePermission("volunteers.manage_compliance");
  await runAction({
    work: () => createTraining({ name: String(formData.get("name") ?? "") }, person.personId),
    domainErrors: [EhsValidationError],
    errorRedirect: (msg) => `/volunteers/ehs/manage?error=${encodeURIComponent(msg)}`,
    revalidate: "/volunteers/ehs/manage",
    successRedirect: "/volunteers/ehs/manage",
  });
}

export async function updateTrainingAction(formData: FormData): Promise<void> {
  const person = await requirePermission("volunteers.manage_compliance");
  const id = String(formData.get("trainingId"));
  await runAction({
    work: () =>
      updateTraining(
        id,
        {
          name: String(formData.get("name") ?? ""),
          description: String(formData.get("description") ?? ""),
          isActive: formData.get("isActive") === "on",
          requiredForAll: formData.get("requiredForAll") === "on",
        },
        person.personId
      ),
    domainErrors: [EhsValidationError],
    errorRedirect: (msg) => `/volunteers/ehs/manage/${id}?error=${encodeURIComponent(msg)}`,
    revalidate: `/volunteers/ehs/manage/${id}`,
  });
}

export async function setTrainingDepartmentsAction(formData: FormData): Promise<void> {
  const person = await requirePermission("volunteers.manage_compliance");
  const trainingId = String(formData.get("trainingId"));
  const departmentIds = formData.getAll("departmentIds").map(String);
  await setTrainingDepartments(trainingId, departmentIds, person.personId);
  revalidatePath(`/volunteers/ehs/manage/${trainingId}`);
}
