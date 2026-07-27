"use server";
import { redirect } from "next/navigation";
import { prisma } from "@/platform/db";
import { requirePersonSession } from "@/platform/auth/session";
import { captureEvent } from "@/platform/posthog/capture";
import { termGroupForCycle } from "@/platform/posthog/groups";
import { getSetting } from "@/platform/settings/service";
import { createOrResendContract, withdrawContract, ContractError } from "@/modules/recruitment/services/onboarding";
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
  const base = await getSetting<string>("app.baseUrl");
  let sent = 0, failed = 0;
  for (const acceptanceId of ids) {
    if (!owned.has(acceptanceId)) { failed += 1; continue; }
    try { await createOrResendContract(acceptanceId, person.personId, base); sent += 1; }
    catch (err) {
      if (err instanceof RecruitmentAuthError || err instanceof ContractError) { failed += 1; continue; }
      throw err;
    }
  }
  if (sent > 0) {
    await captureEvent({
      distinctId: person.personId,
      event: "onboarding_links_sent",
      properties: { cycle_id: cycleId, sent, failed },
      groups: await termGroupForCycle(cycleId),
    });
  }
  redirect(bounce(cycleId, failed > 0 ? { msg: `Sent ${sent} onboarding link(s).`, err: `${failed} could not be sent.` } : { msg: `Sent ${sent} onboarding link(s).` }));
}

export async function withdrawContractAction(cycleId: string, formData: FormData) {
  const person = await requirePersonSession();
  const contractId = String(formData.get("contractId") ?? "");
  // Scope to this cycle: only withdraw a contract that belongs here.
  const owned = await prisma.onboardingContract.findFirst({
    where: { id: contractId, acceptance: { application: { cycleId } } },
    select: { id: true },
  });
  if (!owned) redirect(bounce(cycleId, { err: "Onboarding contract not found." }));
  try {
    await withdrawContract(contractId, person.personId);
  } catch (err) {
    if (err instanceof RecruitmentAuthError || err instanceof ContractError) {
      redirect(bounce(cycleId, { err: (err as Error).message }));
    }
    throw err;
  }
  redirect(bounce(cycleId, { msg: "Onboarding contract withdrawn. You can now change the decision or resend a fresh link." }));
}

export async function promoteAction(cycleId: string, formData: FormData) {
  const person = await requirePersonSession();
  const ids = formData.getAll("contractId").map(String);
  if (ids.length === 0) redirect(bounce(cycleId, { err: "Select at least one contract." }));
  // Scope to this cycle.
  const owned = (await prisma.onboardingContract.findMany({ where: { id: { in: ids }, acceptance: { application: { cycleId } } }, select: { id: true } })).map((c) => c.id);
  try {
    const res = await promoteContracts(owned, person.personId);
    await captureEvent({
      distinctId: person.personId,
      event: "volunteers_promoted",
      properties: { cycle_id: cycleId, created: res.created, reactivated: res.reactivated, skipped: res.skipped, failed: res.failed },
      groups: await termGroupForCycle(cycleId),
    });
    const summary = `Promoted: ${res.created} new, ${res.reactivated} returning, ${res.skipped} skipped.`;
    // A contract that errored out is NOT a benign skip: that person was never
    // created and holds no membership, so they are absent from every roster for
    // the term. Surface it as an error so the SRR retries rather than reading a
    // green banner and moving on.
    if (res.failed > 0) {
      redirect(bounce(cycleId, {
        err: `${summary} ${res.failed} failed to promote and must be retried.`,
      }));
    }
    redirect(bounce(cycleId, { msg: summary }));
  } catch (err) {
    if (err instanceof RecruitmentAuthError) redirect(bounce(cycleId, { err: (err as Error).message }));
    throw err;
  }
}
