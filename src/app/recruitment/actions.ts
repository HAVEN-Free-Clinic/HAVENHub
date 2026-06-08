"use server";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requirePermission } from "@/platform/auth/session";
import {
  createCycle, publishCycle, closeCycle, setAcceptsRenewals, CyclePublishError,
} from "@/modules/recruitment/services/cycles";

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
  await closeCycle(cycleId, person.personId);
  revalidatePath(`/recruitment/cycles/${cycleId}`);
}

export async function toggleRenewalsAction(cycleId: string, value: boolean) {
  const person = await requirePermission("recruitment.manage_cycles");
  await setAcceptsRenewals(cycleId, value, person.personId);
  revalidatePath(`/recruitment/cycles/${cycleId}`);
}
