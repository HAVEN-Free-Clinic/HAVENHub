"use server";
import { revalidatePath } from "next/cache";
import type { Track } from "@prisma/client";
import { requirePermission } from "@/platform/auth/session";
import { saveGlobalContractLayout, resetGlobalContractLayout } from "@/modules/recruitment/contract/template";
import { ContractLayoutError, type ContractLayout } from "@/modules/recruitment/contract/layout";

export type ActionResult = { ok: true } | { ok: false; error: string };

export async function saveGlobalContractAction(track: Track, layout: ContractLayout): Promise<ActionResult> {
  const session = await requirePermission("admin.manage_settings");
  try {
    await saveGlobalContractLayout(track, layout, session.personId);
  } catch (err) {
    if (err instanceof ContractLayoutError) return { ok: false, error: err.message };
    throw err;
  }
  revalidatePath("/admin/contract");
  return { ok: true };
}

/** Clear the master template for a track so its cycles fall back to the built-in
 *  default -- the recovery path the global editor previously lacked (#3). */
export async function resetGlobalContractAction(track: Track): Promise<ActionResult> {
  const session = await requirePermission("admin.manage_settings");
  await resetGlobalContractLayout(track, session.personId);
  revalidatePath("/admin/contract");
  return { ok: true };
}
