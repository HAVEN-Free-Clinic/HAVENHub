/**
 * The one normalization for the identity columns an applicant types.
 *
 * Three places answer "which Person is this applicant?" from the same two
 * contract fields -- `lookupStoredEpicId`, `lookupHasAccount`, and
 * `promoteContracts` -- and they used two different keys. Promotion trimmed and
 * lowercased first (the audit-11 T7 fix, whose comment notes that "trimming the
 * match key also stops a whitespace-padded contract value from missing an
 * existing person"); the two lookups passed the raw column into a
 * case-insensitive `equals`, which is whitespace-SENSITIVE.
 *
 * The padding is reachable: SHORT_TEXT answers are not trimmed by
 * `buildApplicationSchema`, `submissions.ts` stores `answers.net_id` verbatim,
 * and `submitContract` pins the seeded value. So the contract page and the submit
 * validator could conclude there is no matching Person while promotion, minutes
 * later, matched one -- freezing `storedEpicId: null` into the signed record and
 * re-collecting an Epic ID already on file (audit 14, ONB-4).
 *
 * Exported as one helper so a fourth resolver cannot drift again.
 */
export function normalizeIdentityKey(value: string | null | undefined): string | null {
  return value?.trim().toLowerCase() || null;
}
