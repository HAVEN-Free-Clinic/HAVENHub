"use server";
import { revalidatePath } from "next/cache";
import { requirePermission } from "@/platform/auth/session";
import { saveGlobalContractLayout } from "@/modules/recruitment/contract/template";
import { ContractLayoutError, type ContractLayout } from "@/modules/recruitment/contract/layout";

export type ActionResult = { ok: true } | { ok: false; error: string };

export async function saveGlobalContractAction(layout: ContractLayout): Promise<ActionResult> {
  const session = await requirePermission("admin.manage_settings");
  try {
    await saveGlobalContractLayout(layout, session.personId);
  } catch (err) {
    if (err instanceof ContractLayoutError) return { ok: false, error: err.message };
    throw err;
  }
  revalidatePath("/admin/contract");
  return { ok: true };
}
