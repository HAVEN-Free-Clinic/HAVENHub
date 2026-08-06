/**
 * Retired or mistyped codes, mapped to their live equivalents. Every entry
 * was confirmed by ops on 2026-08-05 against the real unresolved list;
 * NONE were guessed. That distinction is the point: TBAD and LCCN resolve
 * to departments no string-similarity matcher would ever reach, while ICCD
 * and FCLR look exactly like transpositions a fuzzy matcher WOULD have
 * "corrected" without any authority to do so.
 *
 * Row counts at confirmation, 163 rows total:
 *   TBAD 49, PNTC 37, SCTL 26, ICCD 19, LCCN 14, SR&R 8, ITCC 7, FCLR 3
 */
export const DEPARTMENT_ALIASES: Record<string, string> = {
  TBAD: "ICDD",
  PNTC: "PNLC",
  SCTL: "SCTP",
  ICCD: "ICDD",
  LCCN: "PNLC",
  "SR&R": "SRR",
  ITCC: "ITCM",
  FCLR: "FCRL",
};

/**
 * Old bases spell a department three ways: the bare code ("BVHD"), a friendly
 * label with the code in parentheses, and occasionally a retired code. The
 * resolver never invents a code: an unrecognized value returns null and is
 * surfaced in the dry-run report, because silently coercing it would attribute
 * an application to the wrong department forever.
 */
export function resolveDepartmentCode(
  raw: string | null | undefined,
  knownCodes: Set<string>,
): string | null {
  const value = raw?.trim();
  if (!value) return null;

  const upper = value.toUpperCase();
  // Alias first, but its target is still validated below, so an alias
  // pointing at a department that no longer exists returns null rather
  // than writing a dangling code.
  const aliased = DEPARTMENT_ALIASES[upper] ?? upper;
  if (knownCodes.has(aliased)) return aliased;

  const bracketed = value.match(/\(([^)]+)\)\s*$/);
  if (bracketed) {
    const code = bracketed[1].trim().toUpperCase();
    // Same alias-then-validate treatment as the primary path above: a
    // retired code inside the parentheses ("Pediatrics (PNTC)") must resolve
    // exactly like the bare code ("PNTC") does.
    const aliasedCode = DEPARTMENT_ALIASES[code] ?? code;
    if (knownCodes.has(aliasedCode)) return aliasedCode;
  }
  return null;
}

export function resolveDepartmentCodes(
  raw: Array<string | null | undefined>,
  knownCodes: Set<string>,
): { codes: string[]; unmapped: string[] } {
  const codes: string[] = [];
  const unmapped: string[] = [];
  for (const value of raw) {
    const trimmed = value?.trim();
    if (!trimmed) continue;
    const code = resolveDepartmentCode(trimmed, knownCodes);
    if (!code) {
      if (!unmapped.includes(trimmed)) unmapped.push(trimmed);
      continue;
    }
    if (!codes.includes(code)) codes.push(code);
  }
  return { codes, unmapped };
}
