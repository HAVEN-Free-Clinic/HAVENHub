import type { Track } from "@prisma/client";

// Airtable used a few codes that differ from the repo Department seed.
const ALIASES: Record<string, string> = { FCLR: "FCRL", "SR&R": "SRR" };

export function normalizeDeptCode(code: string): string {
  const c = code.trim().toUpperCase();
  return ALIASES[c] ?? c;
}

// Canonical (normalized) department codes that carry a supplement section.
// Populated fully in Task 8; the two below let the mechanism land first.
export const SUPPLEMENT_DEPARTMENTS: Record<Track, string[]> = {
  VOLUNTEER: ["MDIC", "SRHD"],
  DIRECTOR: ["BVHD", "MDIC"],
};
