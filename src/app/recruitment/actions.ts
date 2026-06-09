"use server";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requirePermission } from "@/platform/auth/session";
import {
  createCycle, publishCycle, closeCycle, setAcceptsRenewals, CyclePublishError,
} from "@/modules/recruitment/services/cycles";
import { setTrainingCycle, updateQuizSettings, TrainingStateError } from "@/modules/recruitment/services/training";
import { RecruitmentAuthError } from "@/modules/recruitment/services/review";

function slugify(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

export async function createCycleAction(formData: FormData) {
  const person = await requirePermission("recruitment.manage_cycles");
  const title = String(formData.get("title") ?? "").trim();
  const track = String(formData.get("track") ?? "VOLUNTEER") as "VOLUNTEER" | "DIRECTOR";
  const termId = String(formData.get("termId") ?? "");
  const departments = String(formData.get("departments") ?? "").split(",").map((d) => d.trim()).filter(Boolean);
  const slug = slugify(String(formData.get("publicSlug") || title));
  if (!title || !slug) {
    redirect(`/recruitment/cycles/new?error=${encodeURIComponent("Title is required.")}`);
  }
  const cycle = await createCycle({ track, termId, title, publicSlug: slug, departments, acceptsRenewals: false, createdById: person.personId });
  redirect(`/recruitment/cycles/${cycle.id}/builder`);
}

export async function publishCycleAction(cycleId: string) {
  const person = await requirePermission("recruitment.manage_cycles");
  try {
    await publishCycle(cycleId, person.personId);
  } catch (err) {
    if (err instanceof CyclePublishError) {
      redirect(`/recruitment/cycles/${cycleId}?error=${encodeURIComponent(err.message)}`);
    }
    throw err;
  }
  revalidatePath(`/recruitment/cycles/${cycleId}`);
}

export async function closeCycleAction(cycleId: string) {
  const person = await requirePermission("recruitment.manage_cycles");
  try {
    await closeCycle(cycleId, person.personId);
  } catch (err) {
    if (err instanceof CyclePublishError) {
      redirect(`/recruitment/cycles/${cycleId}?error=${encodeURIComponent(err.message)}`);
    }
    throw err;
  }
  revalidatePath(`/recruitment/cycles/${cycleId}`);
}

export async function toggleRenewalsAction(cycleId: string, value: boolean) {
  const person = await requirePermission("recruitment.manage_cycles");
  try {
    await setAcceptsRenewals(cycleId, value, person.personId);
  } catch (err) {
    if (err instanceof CyclePublishError) {
      redirect(`/recruitment/cycles/${cycleId}?error=${encodeURIComponent(err.message)}`);
    }
    throw err;
  }
  revalidatePath(`/recruitment/cycles/${cycleId}`);
}

export async function setTrainingCycleAction(cycleId: string, value: boolean) {
  const person = await requirePermission("recruitment.manage_cycles");
  try {
    await setTrainingCycle(cycleId, value, person.personId);
  } catch (err) {
    if (err instanceof TrainingStateError || err instanceof RecruitmentAuthError) {
      redirect(`/recruitment/cycles/${cycleId}?error=${encodeURIComponent((err as Error).message)}`);
    }
    throw err;
  }
  revalidatePath(`/recruitment/cycles/${cycleId}`);
}

export async function updateQuizSettingsAction(cycleId: string, formData: FormData) {
  const person = await requirePermission("recruitment.manage_cycles");
  const quizPassPercent = Number(formData.get("quizPassPercent"));
  const quizMaxAttempts = Number(formData.get("quizMaxAttempts"));
  try {
    await updateQuizSettings(cycleId, { quizPassPercent, quizMaxAttempts }, person.personId);
  } catch (err) {
    if (err instanceof TrainingStateError) {
      redirect(`/recruitment/cycles/${cycleId}?error=${encodeURIComponent(err.message)}`);
    }
    throw err;
  }
  revalidatePath(`/recruitment/cycles/${cycleId}`);
}
