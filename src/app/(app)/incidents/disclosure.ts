/**
 * Reviewer-audience disclosure shown on the report form (page.tsx) and on a
 * submitted report's detail page ([id]/page.tsx). Plain module (not "use
 * client"): pure string helpers used from server components, same pattern as
 * subject-display.ts.
 *
 * These deliberately state NO headcount. They used to name the exact number of
 * reviewers, and separately the number of external supervisors, computed live
 * from incidentAudience() and the escalation setting. Both numbers are gone:
 *
 *  - The reviewer count was a live role-assignment total. It moved whenever
 *    roles rotated, it forced every render of both pages to run a
 *    permission-holder query purely to produce a number, and it told a reporter
 *    nothing they could act on.
 *  - The external count described a blind copy that no longer exists. Forwarding
 *    outside the clinic is now a reviewer's per-report decision (forward.ts), so
 *    there is no fixed external audience to promise at submission time.
 *
 * What DOES remain is the anonymity warning, and it must: the checkbox reads as
 * though it hides the reporter, and it does not hide them from reviewers. That
 * sentence is the only thing preventing someone from checking the box believing
 * a protection they are not getting.
 *
 * The two exports below are deliberately not one string reused in two places.
 * They serve readers standing in a different grammatical relation to their own
 * name:
 *
 * - The form sits directly under a field labelled "Your name" and above a
 *   checkbox the reporter has not yet checked, so it speaks in second person
 *   about a choice not yet made. Third person there ("the reporter's name") is a
 *   deniable referent: a scanning reader can take it as a statement about
 *   reports in general, or about someone else, and walk away believing the field
 *   above is protected when it isn't.
 * - The detail page's readers include reviewers, for whom "the reporter's name"
 *   is the correct referent, and by the time this renders the report genuinely
 *   has been marked anonymous or not, so it keeps third person.
 *
 * Keeping both here, in one module, means an edit to the guarantee they make has
 * to touch both strings at once, rather than drifting silently the way two
 * copy-pasted doc comments did.
 */

/**
 * Second person, present tense, for the report form. Sits between the "Your
 * name" field and the anonymity checkbox, so it names a choice the reporter has
 * not made yet ("whether or not you check the box below") rather than a state
 * ("marked anonymous") that does not exist until they submit.
 */
export function formReviewerDisclosure(): string {
  return "This report goes to the clinic's incident reviewers. They see your name whether or not you check the box below. A reviewer may also forward it to a clinical supervisor outside the clinic.";
}

/** Third person, for a report that has already been submitted. */
export function detailReviewerDisclosure(): string {
  return "This report goes to the clinic's incident reviewers. They see the reporter's name whether or not the report is marked anonymous. A reviewer may also forward it to a clinical supervisor outside the clinic.";
}
