import { prisma } from "@/platform/db";
import { setSetting } from "@/platform/settings/service";
import type { ContractLayout } from "./layout";
import { parseContractLayout } from "./layout";
import { resolveContractLayout } from "./resolve";
import { assertTwoTier } from "./block-ops";

export { applyBlockOp, assertTwoTier } from "./block-ops";
export type { BlockOp, BlockPatch } from "./block-ops";

/* ------------------------------------------------------------------ */
/* DB: per-cycle + global layout persistence                           */
/* ------------------------------------------------------------------ */

export async function getContractLayoutForEdit(
  cycleId: string
): Promise<{ layout: ContractLayout; hasOverride: boolean }> {
  const row = await prisma.recruitmentCycleContract.findUnique({ where: { cycleId } });
  if (row) return { layout: parseContractLayout(row.layout), hasOverride: true };
  return { layout: await resolveContractLayout(cycleId), hasOverride: false };
}

export async function saveCycleContractLayout(cycleId: string, layout: ContractLayout): Promise<void> {
  const parsed = parseContractLayout(layout);
  assertTwoTier(parsed);
  await prisma.recruitmentCycleContract.upsert({
    where: { cycleId },
    create: { cycleId, layout: parsed as object },
    update: { layout: parsed as object },
  });
}

export async function resetCycleContractLayout(cycleId: string): Promise<void> {
  await prisma.recruitmentCycleContract.deleteMany({ where: { cycleId } });
}

/** actorPersonId is threaded through to setSetting for the audit log (see
 *  platform/branding/assets.ts for the same convention); the brief's sketch
 *  omits it, but setSetting requires an actor to record who changed the
 *  master template. */
export async function saveGlobalContractLayout(
  layout: ContractLayout,
  actorPersonId: string | null
): Promise<void> {
  const parsed = parseContractLayout(layout);
  assertTwoTier(parsed);
  await setSetting("onboarding.contractTemplate", parsed, actorPersonId);
}
