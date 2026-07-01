"use server";

import { requirePermission } from "@/platform/auth/session";
import { runAction } from "@/platform/actions";
import {
  createTraining,
  updateTraining,
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
        },
        person.personId
      ),
    domainErrors: [EhsValidationError],
    errorRedirect: (msg) => `/volunteers/ehs/manage/${id}?error=${encodeURIComponent(msg)}`,
    revalidate: `/volunteers/ehs/manage/${id}`,
  });
}
