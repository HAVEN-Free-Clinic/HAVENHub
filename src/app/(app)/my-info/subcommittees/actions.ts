"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireModuleAccess } from "@/platform/auth/session";
import {
  joinSubcommittee,
  leaveSubcommittee,
  SubcommitteeSignupError,
} from "@/modules/admin/services/subcommittee-members";

const PAGE = "/my-info/subcommittees";

/** Self-service join. The person is always the signed-in one, never a form value. */
export async function joinAction(formData: FormData): Promise<void> {
  const person = await requireModuleAccess("my-info");
  const id = String(formData.get("subcommitteeId") ?? "");
  try {
    await joinSubcommittee(person.personId, id);
  } catch (err) {
    if (err instanceof SubcommitteeSignupError) {
      redirect(`${PAGE}?error=${encodeURIComponent(err.message)}`);
    }
    throw err;
  }
  revalidatePath(PAGE);
  revalidatePath("/my-info");
  redirect(`${PAGE}?joined=1`);
}

export async function leaveAction(formData: FormData): Promise<void> {
  const person = await requireModuleAccess("my-info");
  const id = String(formData.get("subcommitteeId") ?? "");
  try {
    await leaveSubcommittee(person.personId, id);
  } catch (err) {
    if (err instanceof SubcommitteeSignupError) {
      redirect(`${PAGE}?error=${encodeURIComponent(err.message)}`);
    }
    throw err;
  }
  revalidatePath(PAGE);
  revalidatePath("/my-info");
  redirect(`${PAGE}?left=1`);
}
