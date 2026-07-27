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

/**
 * Extract the master-template default that applies to `track` from the stored
 * `onboarding.contractTemplate` setting.
 *
 * The setting is a per-track map `{ VOLUNTEER?, DIRECTOR? }`, so a template saved
 * for one track never overrides the other's built-in default. A LEGACY flat
 * `ContractLayout` (from before the template was split by track, when the global
 * editor only ever seeded the VOLUNTEER layout) is treated as the VOLUNTEER
 * template ONLY -- so it can no longer leak the volunteer contract onto every
 * DIRECTOR cycle, which is the #3 defect. DIRECTOR cycles then fall through to
 * the director code default until a director template is explicitly saved.
 */
export function pickGlobalForTrack(raw: unknown, track: Track): unknown {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  if ("VOLUNTEER" in obj || "DIRECTOR" in obj) return obj[track] ?? null;
  return track === "VOLUNTEER" ? raw : null; // legacy flat template = volunteer only
}

export async function resolveContractLayout(cycleId: string): Promise<ContractLayout> {
  const [row, globalRaw, cycle] = await Promise.all([
    prisma.recruitmentCycleContract.findUnique({ where: { cycleId } }),
    getSetting<unknown>("onboarding.contractTemplate"),
    prisma.recruitmentCycle.findUniqueOrThrow({ where: { id: cycleId }, select: { track: true } }),
  ]);
  return resolveLayoutSources(row?.layout ?? null, pickGlobalForTrack(globalRaw, cycle.track), cycle.track);
}
