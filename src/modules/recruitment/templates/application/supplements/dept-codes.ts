import type { Track } from "@prisma/client";

// Airtable used a few codes that differ from the repo Department seed.
const ALIASES: Record<string, string> = { FCLR: "FCRL", "SR&R": "SRR" };

export function normalizeDeptCode(code: string): string {
  const c = code.trim().toUpperCase();
  return ALIASES[c] ?? c;
}

// Canonical (normalized) department codes that carry a supplement section,
// extracted verbatim from the live Airtable application forms.
export const SUPPLEMENT_DEPARTMENTS: Record<Track, string[]> = {
  VOLUNTEER: ["CCRH", "EDUC", "JCTP", "JCTS", "LABR", "MDIC", "ORHI", "PATS", "QAQI", "SCTP", "SCTS"],
  DIRECTOR: [
    "EXEC", "JONES", "EDUC", "ICDD", "MDIC", "PCAR", "ITCM", "LABR", "ORHI", "QAQI",
    "REFF", "SOSE", "SRHD", "VADM", "FIND", "INTP", "PHAM", "SRR",
  ],
};
