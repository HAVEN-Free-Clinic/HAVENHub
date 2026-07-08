import { prisma } from "@/platform/db";
import { getSetting } from "@/platform/settings/service";
import type { ContractLayout } from "./layout";
import { parseContractLayout } from "./layout";
import { DEFAULT_CONTRACT_LAYOUT } from "./system-fields";

function safe(value: unknown): ContractLayout | null {
  if (value == null) return null;
  try { return parseContractLayout(value); } catch { return null; }
}

/** Pure precedence merge, DB-free: cycle override -> global default -> code default. */
export function resolveLayoutSources(cycleOverride: unknown, globalDefault: unknown): ContractLayout {
  return safe(cycleOverride) ?? safe(globalDefault) ?? DEFAULT_CONTRACT_LAYOUT;
}

export async function resolveContractLayout(cycleId: string): Promise<ContractLayout> {
  const [row, globalDefault] = await Promise.all([
    prisma.recruitmentCycleContract.findUnique({ where: { cycleId } }),
    getSetting<unknown>("onboarding.contractTemplate"),
  ]);
  return resolveLayoutSources(row?.layout ?? null, globalDefault);
}
