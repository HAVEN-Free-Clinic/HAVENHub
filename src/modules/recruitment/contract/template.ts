import type { Track } from "@prisma/client";
import { prisma } from "@/platform/db";
import { getSetting, setSetting, resetSetting } from "@/platform/settings/service";
import type { ContractLayout } from "./layout";
import { parseContractLayout, ContractLayoutError } from "./layout";
import { resolveContractLayout, pickGlobalForTrack } from "./resolve";
import { defaultContractLayout } from "./system-fields";
import { assertTwoTier } from "./block-ops";

const GLOBAL_KEY = "onboarding.contractTemplate";

/** Normalize the stored master template into a mutable per-track map. A legacy
 *  flat layout is adopted as the VOLUNTEER entry (that is what the global editor
 *  always produced), so saving a director template never clobbers it and vice
 *  versa. */
function toTrackMap(raw: unknown): Partial<Record<Track, unknown>> {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) return {};
  const obj = raw as Record<string, unknown>;
  if ("VOLUNTEER" in obj || "DIRECTOR" in obj) {
    const map: Partial<Record<Track, unknown>> = {};
    if (obj.VOLUNTEER != null) map.VOLUNTEER = obj.VOLUNTEER;
    if (obj.DIRECTOR != null) map.DIRECTOR = obj.DIRECTOR;
    return map;
  }
  return { VOLUNTEER: raw }; // legacy flat template = volunteer
}

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

/** Mirrors form-builder's assertCycleEditable: a cycle stays editable through
 *  OPEN and CLOSED (directors may need to adjust the contract mid-cycle);
 *  only ARCHIVED (the terminal, retired state) locks it. */
async function assertContractEditable(cycleId: string): Promise<void> {
  const cycle = await prisma.recruitmentCycle.findUnique({ where: { id: cycleId }, select: { status: true } });
  if (!cycle) throw new ContractLayoutError(["Cycle not found."]);
  if (cycle.status === "ARCHIVED") {
    throw new ContractLayoutError(["This cycle is archived and can no longer be edited."]);
  }
}

export async function saveCycleContractLayout(cycleId: string, layout: ContractLayout): Promise<void> {
  await assertContractEditable(cycleId);
  const parsed = parseContractLayout(layout);
  assertTwoTier(parsed);
  await prisma.recruitmentCycleContract.upsert({
    where: { cycleId },
    create: { cycleId, layout: parsed as object },
    update: { layout: parsed as object },
  });
}

export async function resetCycleContractLayout(cycleId: string): Promise<void> {
  await assertContractEditable(cycleId);
  await prisma.recruitmentCycleContract.deleteMany({ where: { cycleId } });
}

/** The master template for a track (for the /admin/contract editor), plus whether
 *  a custom one is stored (vs the built-in code default for that track). */
export async function getGlobalContractLayout(
  track: Track
): Promise<{ layout: ContractLayout; hasOverride: boolean }> {
  const picked = pickGlobalForTrack(await getSetting<unknown>(GLOBAL_KEY), track);
  if (picked != null) {
    try { return { layout: parseContractLayout(picked), hasOverride: true }; } catch { /* fall through */ }
  }
  return { layout: defaultContractLayout(track), hasOverride: false };
}

/** Save the master template for ONE track, merging into the per-track map so a
 *  volunteer save never overwrites the director template or vice versa (#3).
 *  actorPersonId is threaded to setSetting for the audit log. */
export async function saveGlobalContractLayout(
  track: Track,
  layout: ContractLayout,
  actorPersonId: string | null
): Promise<void> {
  const parsed = parseContractLayout(layout);
  assertTwoTier(parsed);
  const map = toTrackMap(await getSetting<unknown>(GLOBAL_KEY));
  map[track] = parsed;
  await setSetting(GLOBAL_KEY, map, actorPersonId);
}

/** Clear the master template for a track so its cycles fall back to the built-in
 *  default. This is the reset the global editor lacked -- without it a bad save
 *  (e.g. the volunteer layout stored globally) could never be undone (#3). When no
 *  track's template remains, the setting is cleared entirely. */
export async function resetGlobalContractLayout(
  track: Track,
  actorPersonId: string | null
): Promise<void> {
  const map = toTrackMap(await getSetting<unknown>(GLOBAL_KEY));
  delete map[track];
  if (Object.keys(map).length === 0) {
    await resetSetting(GLOBAL_KEY, actorPersonId);
  } else {
    await setSetting(GLOBAL_KEY, map, actorPersonId);
  }
}
