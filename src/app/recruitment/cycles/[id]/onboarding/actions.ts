"use server";
import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { requirePersonSession } from "@/platform/auth/session";
import { createOrResendContract, ContractError } from "@/modules/recruitment/services/onboarding";
import { promoteContracts } from "@/modules/recruitment/services/promotion";
import { RecruitmentAuthError } from "@/modules/recruitment/services/review";

async function baseUrl(): Promise<string> {
  const h = await headers();
  const host = h.get("host") ?? "localhost:3000";
  const proto = h.get("x-forwarded-proto") ?? "http";
  return `${proto}://${host}`;
}
function bounce(cycleId: string, msg: string) {
  return `/recruitment/cycles/${cycleId}/onboarding?msg=${encodeURIComponent(msg)}`;
}

export async function sendLinksAction(cycleId: string, formData: FormData) {
  const person = await requirePersonSession();
  const ids = formData.getAll("acceptanceId").map(String);
  const base = await baseUrl();
  let sent = 0;
  try {
    for (const acceptanceId of ids) { await createOrResendContract(acceptanceId, person.personId, base); sent += 1; }
  } catch (err) {
    if (err instanceof RecruitmentAuthError || err instanceof ContractError) redirect(bounce(cycleId, (err as Error).message));
    throw err;
  }
  redirect(bounce(cycleId, `Sent ${sent} onboarding link(s).`));
}

export async function promoteAction(cycleId: string, formData: FormData) {
  const person = await requirePersonSession();
  const ids = formData.getAll("contractId").map(String);
  try {
    const res = await promoteContracts(ids, person.personId);
    redirect(bounce(cycleId, `Promoted: ${res.created} new, ${res.reactivated} returning, ${res.skipped} skipped.`));
  } catch (err) {
    if (err instanceof RecruitmentAuthError) redirect(bounce(cycleId, (err as Error).message));
    throw err;
  }
}
