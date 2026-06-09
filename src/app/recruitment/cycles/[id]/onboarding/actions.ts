"use server";
import { redirect } from "next/navigation";
import { prisma } from "@/platform/db";
import { config } from "@/platform/config";
import { requirePersonSession } from "@/platform/auth/session";
import { createOrResendContract, ContractError } from "@/modules/recruitment/services/onboarding";
import { promoteContracts } from "@/modules/recruitment/services/promotion";
import { RecruitmentAuthError } from "@/modules/recruitment/services/review";

function bounce(cycleId: string, params: { msg?: string; err?: string }) {
  const q = new URLSearchParams();
  if (params.msg) q.set("msg", params.msg);
  if (params.err) q.set("err", params.err);
  return `/recruitment/cycles/${cycleId}/onboarding?${q.toString()}`;
}

export async function sendLinksAction(cycleId: string, formData: FormData) {
  const person = await requirePersonSession();
  const ids = formData.getAll("acceptanceId").map(String);
  if (ids.length === 0) redirect(bounce(cycleId, { err: "Select at least one applicant." }));
  // Scope to this cycle: ignore any acceptance id that does not belong to it.
  const owned = new Set((await prisma.acceptance.findMany({ where: { id: { in: ids }, application: { cycleId } }, select: { id: true } })).map((a) => a.id));
  const base = config.APP_BASE_URL;
  let sent = 0, failed = 0;
  for (const acceptanceId of ids) {
    if (!owned.has(acceptanceId)) { failed += 1; continue; }
    try { await createOrResendContract(acceptanceId, person.personId, base); sent += 1; }
    catch (err) {
      if (err instanceof RecruitmentAuthError || err instanceof ContractError) { failed += 1; continue; }
      throw err;
    }
  }
  redirect(bounce(cycleId, failed > 0 ? { msg: `Sent ${sent} onboarding link(s).`, err: `${failed} could not be sent.` } : { msg: `Sent ${sent} onboarding link(s).` }));
}

export async function promoteAction(cycleId: string, formData: FormData) {
  const person = await requirePersonSession();
  const ids = formData.getAll("contractId").map(String);
  if (ids.length === 0) redirect(bounce(cycleId, { err: "Select at least one contract." }));
  // Scope to this cycle.
  const owned = (await prisma.onboardingContract.findMany({ where: { id: { in: ids }, acceptance: { application: { cycleId } } }, select: { id: true } })).map((c) => c.id);
  try {
    const res = await promoteContracts(owned, person.personId);
    redirect(bounce(cycleId, { msg: `Promoted: ${res.created} new, ${res.reactivated} returning, ${res.skipped} skipped.` }));
  } catch (err) {
    if (err instanceof RecruitmentAuthError) redirect(bounce(cycleId, { err: (err as Error).message }));
    throw err;
  }
}
