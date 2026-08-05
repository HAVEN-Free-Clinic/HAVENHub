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
  if (knownCodes.has(upper)) return upper;

  const bracketed = value.match(/\(([^)]+)\)\s*$/);
  if (bracketed) {
    const code = bracketed[1].trim().toUpperCase();
    if (knownCodes.has(code)) return code;
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
