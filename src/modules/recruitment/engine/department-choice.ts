/**
 * The DEPARTMENT_CHOICE answer, read the same way everywhere.
 *
 * A department field asks for `validation.rankCount` ranked choices (default 1).
 * With one choice the answer is stored as a bare code ("SRHD"), exactly as it
 * always was, so every volunteer cycle and every application already on file
 * reads unchanged. With more than one it is stored as an ordered array of codes,
 * first choice first ("SRHD", "SCTP").
 *
 * The form posts one value per ranked slot under the field's key, and a slot the
 * applicant left empty posts "", so the raw answer can be a string, an array with
 * blanks in it, or nothing at all. Every reader goes through
 * departmentChoicesFromAnswer so none of them has to know which.
 *
 * Client-safe: no server imports.
 */

/** The most ranked department choices a form may ask for. */
export const MAX_DEPARTMENT_RANK = 3;

/** How many ranked choices a DEPARTMENT_CHOICE field asks for: 1 to 3, default 1. */
export function departmentRankCount(validation: unknown): number {
  const raw =
    validation && typeof validation === "object"
      ? (validation as { rankCount?: unknown }).rankCount
      : undefined;
  if (typeof raw !== "number" || !Number.isFinite(raw)) return 1;
  return Math.max(1, Math.min(MAX_DEPARTMENT_RANK, Math.floor(raw)));
}

/** The department codes an answer names, in rank order, with blanks and repeats
 *  dropped. Accepts the scalar (rankCount 1) and the array (ranked) shapes. */
export function departmentChoicesFromAnswer(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw : raw == null ? [] : [raw];
  const out: string[] = [];
  for (const v of list) {
    if (typeof v !== "string") continue;
    const code = v.trim();
    if (code !== "" && !out.includes(code)) out.push(code);
  }
  return out;
}

/** The label above each ranked slot. */
export function rankOrdinal(index: number): string {
  return ["1st choice", "2nd choice", "3rd choice"][index] ?? `Choice ${index + 1}`;
}

/** Ranked choices as one line of text: "Surgery (1st), Pediatrics (2nd)". A
 *  single choice reads as just its label, as it always did. */
export function formatRankedDepartments(codes: string[], labelFor: (code: string) => string): string {
  if (codes.length <= 1) return codes.map(labelFor).join("");
  const short = ["1st", "2nd", "3rd"];
  return codes.map((c, i) => `${labelFor(c)} (${short[i] ?? `#${i + 1}`})`).join(", ");
}
