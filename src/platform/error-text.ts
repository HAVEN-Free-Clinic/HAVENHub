/**
 * Refusal sentences the app says in more than one place.
 *
 * Two of them had drifted into three independent copies: the flash toast table
 * (src/platform/ui/toast/flash.ts) and the ERROR_MESSAGES dictionaries on
 * /incidents/new and /incidents/strikes each held their own literal, and
 * flash.ts's doc comment narrated the coupling in prose ("`validation`'s text
 * is copied from the three incidents pages") rather than encoding it. A copy
 * edit landing on one of the three would have quietly left the other two
 * saying something else.
 *
 * Only text that is genuinely shared belongs here. Anything page-specific
 * (`subject-not-found`, `bad-category`, `future-date`, NextAuth's codes) stays
 * in that page's own ERROR_MESSAGES dictionary, and a thrown Error's default
 * message stays in its own service: an exception message is developer-facing
 * and is not UI copy, even when the words happen to match.
 */
export const SHARED_ERROR_TEXT = {
  forbidden: "You do not have permission for that action.",
  validation: "Please check your input and try again.",
} as const;
