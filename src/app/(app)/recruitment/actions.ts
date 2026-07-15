"use server";
import { redirect } from "next/navigation";
import { requirePermission } from "@/platform/auth/session";
import { parseZonedInput } from "@/platform/dates";
import { getDisplayTimeZone } from "@/platform/dates/resolve";
import { isUniqueConstraintError } from "@/platform/db";
import { runAction } from "@/platform/actions";
import {
  createCycle, publishCycle, closeCycle, reopenCycle, archiveCycle, setAcceptsRenewals,
  setApplicationWindow, setCycleDepartments, CyclePublishError,
} from "@/modules/recruitment/services/cycles";
import { setTrainingCycle, updateQuizSettings, TrainingStateError } from "@/modules/recruitment/services/training";
import { RecruitmentAuthError } from "@/modules/recruitment/services/review";
import { isReservedSlug } from "@/modules/recruitment/services/portal-routing";

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
  // Default on (the New-cycle form ships the checkbox checked); unchecked seeds the
  // minimal name+email form so an admin can build from scratch.
  const seedDefaultForm = formData.get("seedDefaultForm") === "on";
  if (!title || !slug) {
    redirect(`/recruitment/cycles/new?error=${encodeURIComponent("Title is required.")}`);
  }
  if (isReservedSlug(slug)) {
    redirect(`/recruitment/cycles/new?error=${encodeURIComponent(`"${slug}" is a reserved word. Choose a different public link.`)}`);
  }
  let cycle;
  try {
    cycle = await createCycle({ track, termId, title, publicSlug: slug, departments, acceptsRenewals: false, createdById: person.personId }, seedDefaultForm);
  } catch (err) {
    // publicSlug is unique. A colliding slug throws P2002; surface the same
    // friendly reserved-word flow instead of the generic error page (audit3 L2).
    // Only claim a slug collision when the failing constraint is actually
    // publicSlug -- any other unique violation (e.g. a duplicate template field
    // key) must not be mislabeled as "public link already taken".
    if (isUniqueConstraintError(err)) {
      const target = String(err.meta?.target ?? "");
      if (!target || target.includes("publicSlug")) {
        redirect(`/recruitment/cycles/new?error=${encodeURIComponent(`"${slug}" is already taken as a public link. Choose a different one.`)}`);
      }
      redirect(`/recruitment/cycles/new?error=${encodeURIComponent("Could not create the cycle. Please review the departments and try again.")}`);
    }
    throw err;
  }
  redirect(`/recruitment/cycles/${cycle.id}/builder`);
}

export async function publishCycleAction(cycleId: string) {
  const person = await requirePermission("recruitment.manage_cycles");
  await runAction({
    work: () => publishCycle(cycleId, person.personId),
    domainErrors: [CyclePublishError],
    errorRedirect: (m) => `/recruitment/cycles/${cycleId}?error=${encodeURIComponent(m)}`,
    revalidate: `/recruitment/cycles/${cycleId}`,
  });
}

export async function closeCycleAction(cycleId: string) {
  const person = await requirePermission("recruitment.manage_cycles");
  await runAction({
    work: () => closeCycle(cycleId, person.personId),
    domainErrors: [CyclePublishError],
    errorRedirect: (m) => `/recruitment/cycles/${cycleId}?error=${encodeURIComponent(m)}`,
    revalidate: `/recruitment/cycles/${cycleId}`,
  });
}

export async function reopenCycleAction(cycleId: string) {
  const person = await requirePermission("recruitment.manage_cycles");
  await runAction({
    work: () => reopenCycle(cycleId, person.personId),
    domainErrors: [CyclePublishError],
    errorRedirect: (m) => `/recruitment/cycles/${cycleId}?error=${encodeURIComponent(m)}`,
    revalidate: `/recruitment/cycles/${cycleId}`,
  });
}

export async function archiveCycleAction(cycleId: string) {
  const person = await requirePermission("recruitment.manage_cycles");
  await runAction({
    work: () => archiveCycle(cycleId, person.personId),
    domainErrors: [CyclePublishError],
    errorRedirect: (m) => `/recruitment/cycles/${cycleId}?error=${encodeURIComponent(m)}`,
    revalidate: `/recruitment/cycles/${cycleId}`,
  });
}

export async function toggleRenewalsAction(cycleId: string, value: boolean) {
  const person = await requirePermission("recruitment.manage_cycles");
  await runAction({
    work: () => setAcceptsRenewals(cycleId, value, person.personId),
    domainErrors: [CyclePublishError],
    errorRedirect: (m) => `/recruitment/cycles/${cycleId}?error=${encodeURIComponent(m)}`,
    revalidate: `/recruitment/cycles/${cycleId}`,
  });
}

export async function setCycleDepartmentsAction(cycleId: string, formData: FormData) {
  const person = await requirePermission("recruitment.manage_cycles");
  const departments = formData.getAll("departments").map(String).map((d) => d.trim()).filter(Boolean);
  let warn = "";
  try {
    const { removedWithApplicants } = await setCycleDepartments(cycleId, departments, person.personId);
    if (removedWithApplicants.length > 0) {
      warn = removedWithApplicants.map((r) => `${r.code} (${r.applicantCount})`).join(", ");
    }
  } catch (err) {
    if (err instanceof CyclePublishError) {
      redirect(`/recruitment/cycles/${cycleId}?error=${encodeURIComponent(err.message)}`);
    }
    throw err;
  }
  redirect(`/recruitment/cycles/${cycleId}?${warn ? `deptwarn=${encodeURIComponent(warn)}` : "deptsaved=1"}`);
}

export async function setApplicationWindowAction(cycleId: string, formData: FormData) {
  const person = await requirePermission("recruitment.manage_cycles");
  const rawOpens = String(formData.get("opensAt") ?? "").trim();
  const rawCloses = String(formData.get("closesAt") ?? "").trim();
  const zone = await getDisplayTimeZone();
  const opensAt = rawOpens ? parseZonedInput(rawOpens, zone) : null;
  const closesAt = rawCloses ? parseZonedInput(rawCloses, zone) : null;
  if ((rawOpens && !opensAt) || (rawCloses && !closesAt)) {
    redirect(`/recruitment/cycles/${cycleId}?error=${encodeURIComponent("Enter valid dates for the application window.")}`);
  }
  try {
    await setApplicationWindow(cycleId, { opensAt, closesAt }, person.personId);
  } catch (err) {
    if (err instanceof CyclePublishError) {
      redirect(`/recruitment/cycles/${cycleId}?error=${encodeURIComponent(err.message)}`);
    }
    throw err;
  }
  redirect(`/recruitment/cycles/${cycleId}?windowsaved=1`);
}

export async function setTrainingCycleAction(cycleId: string, value: boolean) {
  const person = await requirePermission("recruitment.manage_cycles");
  await runAction({
    work: () => setTrainingCycle(cycleId, value, person.personId),
    domainErrors: [TrainingStateError, RecruitmentAuthError],
    errorRedirect: (m) => `/recruitment/cycles/${cycleId}?error=${encodeURIComponent(m)}`,
    revalidate: `/recruitment/cycles/${cycleId}`,
  });
}

export async function updateQuizSettingsAction(cycleId: string, formData: FormData) {
  const person = await requirePermission("recruitment.manage_cycles");
  const quizPassPercent = Number(formData.get("quizPassPercent"));
  const quizMaxAttempts = Number(formData.get("quizMaxAttempts"));
  await runAction({
    work: () => updateQuizSettings(cycleId, { quizPassPercent, quizMaxAttempts }, person.personId),
    domainErrors: [TrainingStateError],
    errorRedirect: (m) => `/recruitment/cycles/${cycleId}?error=${encodeURIComponent(m)}`,
    revalidate: `/recruitment/cycles/${cycleId}`,
  });
}
