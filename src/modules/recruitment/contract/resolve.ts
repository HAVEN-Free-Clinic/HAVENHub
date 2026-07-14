import type { Track } from "@prisma/client";
import { prisma } from "@/platform/db";
import { getSetting } from "@/platform/settings/service";
import type { ContractLayout } from "./layout";
import { parseContractLayout } from "./layout";
import { defaultContractLayout } from "./system-fields";

function safe(value: unknown): ContractLayout | null {
  if (value == null) return null;
  try { return parseContractLayout(value); } catch { return null; }
}

/** Pure precedence merge, DB-free: cycle override -> global default -> code default. */
export function resolveLayoutSources(cycleOverride: unknown, globalDefault: unknown, track: Track): ContractLayout {
  return safe(cycleOverride) ?? safe(globalDefault) ?? defaultContractLayout(track);
}

export async function resolveContractLayout(cycleId: string): Promise<ContractLayout> {
  const [row, globalDefault, cycle] = await Promise.all([
    prisma.recruitmentCycleContract.findUnique({ where: { cycleId } }),
    getSetting<unknown>("onboarding.contractTemplate"),
    prisma.recruitmentCycle.findUniqueOrThrow({ where: { id: cycleId }, select: { track: true } }),
  ]);
  return resolveLayoutSources(row?.layout ?? null, globalDefault, cycle.track);
}
