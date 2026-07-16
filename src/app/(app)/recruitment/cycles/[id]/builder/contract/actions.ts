"use server";
import { revalidatePath } from "next/cache";
import { requirePermission } from "@/platform/auth/session";
import { saveCycleContractLayout, resetCycleContractLayout } from "@/modules/recruitment/contract/template";
import { ContractLayoutError, type ContractLayout } from "@/modules/recruitment/contract/layout";

export type ActionResult = { ok: true } | { ok: false; error: string };

const contractPath = (id: string) => `/recruitment/cycles/${id}/builder/contract`;

export async function saveContractAction(cycleId: string, layout: ContractLayout): Promise<ActionResult> {
  await requirePermission("recruitment.manage_cycles");
  try {
    await saveCycleContractLayout(cycleId, layout);
  } catch (err) {
    if (err instanceof ContractLayoutError) return { ok: false, error: err.message };
    throw err;
  }
  revalidatePath(contractPath(cycleId));
  return { ok: true };
}

export async function resetContractAction(cycleId: string): Promise<ActionResult> {
  await requirePermission("recruitment.manage_cycles");
  try {
    await resetCycleContractLayout(cycleId);
  } catch (err) {
    if (err instanceof ContractLayoutError) return { ok: false, error: err.message };
    throw err;
  }
  revalidatePath(contractPath(cycleId));
  return { ok: true };
}
