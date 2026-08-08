"use server";
import { redirect } from "next/navigation";
import { prisma } from "@/platform/db";
import { requirePersonSession } from "@/platform/auth/session";
import { captureEvent } from "@/platform/posthog/capture";
import { termGroupForCycle } from "@/platform/posthog/groups";
import { getSetting } from "@/platform/settings/service";
import { createOrResendContract, withdrawContracts, ContractError } from "@/modules/recruitment/services/onboarding";
import { promoteContracts } from "@/modules/recruitment/services/promotion";
import { RecruitmentAuthError } from "@/modules/recruitment/services/review";

function bounce(cycleId: string, params: { msg?: string; err?: string }) {
  const q = new URLSearchParams();
  if (params.msg) q.set("msg", params.msg);
  if (params.err) q.set("err", params.err);
  return `/recruitment/cycles/${cycleId}/onboarding?${q.toString()}`;
}

/** Append the informational tail shared by all three actions. A not-eligible row
 *  is an expected outcome of acting on a wide selection, so it rides along with
 *  the success message; only `failed` is an error. */
function summarize(base: string, notEligible: number): string {
  return notEligible > 0 ? `${base} ${notEligible} not eligible.` : base;
}

/** Load the selected acceptances that actually belong to this cycle, with just
 *  enough contract state to decide eligibility server-side. The client's counts
 *  are never trusted. */
async function scopedAcceptances(cycleId: string, ids: string[]) {
  if (ids.length === 0) return [];
  return prisma.acceptance.findMany({
    where: { id: { in: ids }, application: { cycleId } },
    select: { id: true, contract: { select: { id: true, status: true } } },
  });
}

/**
 * The ids an action should act on.
 *
 * A per-row action button submits its own id under `onlyAcceptanceId` and wins
 * outright. Without this, clicking a row's Withdraw while other rows happen to
 * be checked would withdraw the whole selection, because a submit button's
 * name/value rides along with every checked box in the same form.
 */
function selectedIds(formData: FormData): string[] {
  const only = String(formData.get("onlyAcceptanceId") ?? "");
  if (only !== "") return [only];
  return [...new Set(formData.getAll("acceptanceId").map(String))].filter((id) => id !== "");
}

export async function sendLinksAction(cycleId: string, formData: FormData) {
  const person = await requirePersonSession();
  const ids = selectedIds(formData);
  if (ids.length === 0) redirect(bounce(cycleId, { err: "Select at least one applicant." }));

  const rows = await scopedAcceptances(cycleId, ids);
  // Eligible to send: no contract yet, or one still PENDING (createOrResendContract
  // refuses anything else). Ids not in `rows` were never in this cycle.
  const eligible = rows.filter((r) => r.contract == null || r.contract.status === "PENDING");
  const notEligible = ids.length - eligible.length;

  const base = await getSetting<string>("app.baseUrl");
  let sent = 0, failed = 0;
  for (const row of eligible) {
    try {
      await createOrResendContract(row.id, person.personId, base);
      sent += 1;
    } catch (err) {
      // A conflicted acceptance or a closed cycle lands here. It is a refusal,
      // not a crash, so it is reported rather than thrown.
      if (err instanceof RecruitmentAuthError || err instanceof ContractError) { failed += 1; continue; }
      throw err;
    }
  }

  if (sent > 0) {
    await captureEvent({
      distinctId: person.personId,
      event: "onboarding_links_sent",
      properties: { cycle_id: cycleId, sent, not_eligible: notEligible, failed },
      groups: await termGroupForCycle(cycleId),
    });
  }

  const msg = summarize(`Sent ${sent} onboarding link(s).`, notEligible);
  redirect(bounce(cycleId, failed > 0 ? { msg, err: `${failed} could not be sent.` } : { msg }));
}

export async function promoteAction(cycleId: string, formData: FormData) {
  const person = await requirePersonSession();
  const ids = selectedIds(formData);
  if (ids.length === 0) redirect(bounce(cycleId, { err: "Select at least one applicant." }));

  const rows = await scopedAcceptances(cycleId, ids);
  const contractIds = rows
    .filter((r) => r.contract?.status === "SUBMITTED")
    .map((r) => r.contract!.id);
  const notEligible = ids.length - contractIds.length;

  let res: Awaited<ReturnType<typeof promoteContracts>>;
  try {
    res = await promoteContracts(contractIds, person.personId);
  } catch (err) {
    if (err instanceof RecruitmentAuthError) redirect(bounce(cycleId, { err: (err as Error).message }));
    throw err;
  }

  await captureEvent({
    distinctId: person.personId,
    event: "volunteers_promoted",
    properties: {
      cycle_id: cycleId, created: res.created, reactivated: res.reactivated,
      skipped: res.skipped, not_eligible: notEligible, failed: res.failed,
    },
    groups: await termGroupForCycle(cycleId),
  });

  // promoteContracts counts a conflicted or non-submitted contract as `skipped`.
  // Fold that into not-eligible: from the operator's side both mean "nothing
  // happened to that row, and nothing needed to".
  const msg = summarize(
    `Promoted: ${res.created} new, ${res.reactivated} returning.`,
    notEligible + res.skipped,
  );
  // A contract that errored out is NOT a benign skip: that person was never
  // created and holds no membership, so they are absent from every roster for
  // the term. Surface it so the SRR retries rather than reading a green banner.
  redirect(bounce(cycleId, res.failed > 0
    ? { msg, err: `${res.failed} failed to promote and must be retried.` }
    : { msg }));
}

export async function withdrawAction(cycleId: string, formData: FormData) {
  const person = await requirePersonSession();
  const ids = selectedIds(formData);
  if (ids.length === 0) redirect(bounce(cycleId, { err: "Select at least one applicant." }));

  const rows = await scopedAcceptances(cycleId, ids);
  const contractIds = rows
    .filter((r) => r.contract != null && r.contract.status !== "PROMOTED")
    .map((r) => r.contract!.id);
  const notEligible = ids.length - contractIds.length;

  let res: Awaited<ReturnType<typeof withdrawContracts>>;
  try {
    res = await withdrawContracts(contractIds, person.personId);
  } catch (err) {
    if (err instanceof RecruitmentAuthError) redirect(bounce(cycleId, { err: (err as Error).message }));
    throw err;
  }

  const msg = summarize(
    `Withdrew ${res.withdrawn} onboarding contract(s). You can now change the decision or resend a fresh link.`,
    notEligible + res.skipped,
  );
  redirect(bounce(cycleId, res.failed > 0
    ? { msg, err: `${res.failed} could not be withdrawn.` }
    : { msg }));
}
