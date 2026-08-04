/**
 * Reviewer-audience disclosure shown on the report form (page.tsx) and on a
 * submitted report's detail page ([id]/page.tsx). States who actually
 * receives a report, so a reporter deciding whether it's safe to report a
 * colleague isn't guessing, and so a reporter re-reading their own report
 * sees the same promise. Plain module (not "use client"): pure string
 * helpers used from server components, same pattern as subject-display.ts.
 *
 * `reviewerCount` must come from the same query notifyReviewersOfSubmission
 * uses (peopleWithAnyPermission(["incidents.manage"]), report.ts) so neither
 * function ever describes a different audience than the one actually
 * notified. Zero is handled as its own sentence rather than rendering
 * "0 people": if nobody holds incidents.manage, that's stated plainly
 * instead of implied by a false headcount.
 *
 * The two exports below are deliberately not one string reused in two
 * places. They serve readers standing in a different grammatical relation
 * to their own name:
 *
 * - The form sits directly under a field labelled "Your name" and above a
 *   checkbox the reporter has not yet checked, so it speaks in second
 *   person about a choice not yet made. Third person there ("the
 *   reporter's name") is a deniable referent: a scanning reader can take it
 *   as a statement about reports in general, or about someone else, and
 *   walk away believing the field above is protected when it isn't.
 * - The detail page's readers include reviewers, for whom "the reporter's
 *   name" is the correct referent, and by the time this renders the report
 *   genuinely has been marked anonymous or not, so it keeps third person
 *   and present tense for that half of the sentence.
 *
 * Keeping both here, in one module, means an edit to the guarantee they
 * make has to touch both strings at once, rather than drifting silently the
 * way two copy-pasted doc comments did.
 */

function reviewerCountPhrase(reviewerCount: number): string {
  return reviewerCount === 1 ? "1 person" : `${reviewerCount} people`;
}

/**
 * Second person, present tense, for the report form. Sits between the
 * "Your name" field and the anonymity checkbox, so it names a choice the
 * reporter has not made yet ("whether or not you check the box below")
 * rather than a state ("marked anonymous") that does not exist until they
 * submit.
 */
export function formReviewerDisclosure(reviewerCount: number): string {
  if (reviewerCount === 0) {
    return "This report goes to the clinic's incident reviewers. No one currently holds that role, so this report will not reach anyone until someone does.";
  }
  return `This report goes to the clinic's incident reviewers, currently ${reviewerCountPhrase(reviewerCount)}. They see your name whether or not you check the box below.`;
}

/**
 * Third person, for a report that has already been submitted.
 *
 * The zero case uses a past-tense variant, not the form's forward-looking
 * "will not reach anyone until someone does": role assignments are
 * term-scoped, so a zero count on an already-submitted report can simply
 * mean the reviewers who received it at submission time have since rotated
 * out. Claiming it "will not reach anyone" would be false in that case, and
 * the only person who can view a report at reviewerCount 0 is the reporter
 * (a "*" holder would make the count nonzero) -- exactly the person most
 * misled by a false claim that their report never reached anyone.
 */
export function detailReviewerDisclosure(reviewerCount: number): string {
  if (reviewerCount === 0) {
    return "This report goes to the clinic's incident reviewers. No one currently holds that role. If someone did when this report was submitted, it already reached them.";
  }
  return `This report goes to the clinic's incident reviewers, currently ${reviewerCountPhrase(reviewerCount)}. They see the reporter's name whether or not the report is marked anonymous.`;
}
