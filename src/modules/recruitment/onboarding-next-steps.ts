/**
 * Shared "what happens next" content for a volunteer who just submitted their
 * HAVEN Hub onboarding contract. One builder feeds three surfaces: the
 * completion screen (onboard-form.tsx, a client component), the revisit page
 * shown when the same link is opened again (onboard/[token]/page.tsx, a
 * server component), and the confirmation email queued at submit. JSX cannot
 * cross into an email body, so this returns plain strings that every surface
 * renders in its own way (a <p>, a <li>, or a template interpolation) rather
 * than JSX the email could never use.
 *
 * Deliberately NOT included: any Epic setup instructions (VPN, Citrix,
 * portal URLs, training links). Those exist in the codebase (see
 * src/platform/email/templates/epic.ts) but are sent later, by hand, when
 * an IT/support staffer processes the resulting EpicRequest and the real
 * YNHH account exists to describe -- not at contract-submission time. Only
 * a promise that IT will follow up is something the code actually
 * supports; inventing the download steps here would duplicate (and could
 * drift from) that later, real email.
 */

/** How the volunteer signs in, resolved from their onboarding email's domain.
 *  Yale addresses authenticate through SSO (src/platform/auth/match-person.ts);
 *  everyone else requests a one-time emailed link (member-magic-link.ts,
 *  surfaced by the "No yale.edu email?" affordance on /login). Not cosmetic:
 *  a generic "sign in here" would leave a non-Yale volunteer staring at an SSO
 *  button with no idea the magic-link form is their way in. */
export type SignInMethod = "sso" | "magic-link";

export type OnboardingNextSteps = {
  /** Relative path to the sign-in page; same route for both methods. */
  loginPath: string;
  // NOTE for whoever wires this into the email (Task 4): the email render
  // engine (platform/email/render/render.ts) does flat context[key] lookup
  // only, with no dot-path support, so a raw "{{signIn.text}}" token silently
  // renders empty rather than erroring. Flatten this into its own top-level
  // context key (e.g. signInText: steps.signIn.emailText) before templating,
  // matching the flat-context convention epic.ts's *Context builders already
  // use (epicActivationContext, etc.).
  signIn: {
    method: SignInMethod;
    /**
     * Null when this volunteer has no Person to sign in as yet (see
     * `hasAccount` on the input below): telling them to sign in when there is
     * nothing behind that door is exactly the false promise this field exists
     * to prevent. The completion screen and the revisit page suppress both the
     * bullet and the "Sign in to HAVEN Hub" button when this is null. Non-null
     * (and unconditionally true) whenever `hasAccount` is true.
     */
    text: string | null;
    /**
     * Always non-null, and deliberately NOT gated on `hasAccount`: the
     * confirmation email is a durable record queued once at submit time and
     * opened at some unknown later point, so it can never know whether an
     * account exists by the time a human reads it (it usually does not exist
     * yet, and may or may not exist by the time the volunteer opens the
     * email). Phrasing it against the (future) roster-add rather than the
     * volunteer's state at send time keeps it true no matter when it is read,
     * mirroring how `review` is already phrased for the same reason. Only the
     * email uses this; the completion screen and revisit page use `text`.
     */
    emailText: string;
  };
  /** Null when the cycle has no in-person training date scheduled
   *  (RecruitmentCycle.inPersonTrainingDate is nullable). Asserting "plan to
   *  attend training on the scheduled training date" when nothing is actually
   *  scheduled asserts a session that may not exist; suppress the bullet
   *  instead, the same way `epic` is suppressed when there is nothing true to
   *  tell this volunteer. */
  training: string | null;
  /** Null when there is nothing to tell this volunteer about Epic: either
   *  their department has no Epic requirement and they self-reported not
   *  needing it, or (see hasEpic below) their existing account already
   *  covers it. */
  epic: string | null;
  /** Future tense ("will review... and add") unless the input's `reviewed`
   *  flag is set, in which case past tense ("has reviewed... and added"). */
  review: string;
};

export type OnboardingNextStepsInput = {
  /** OnboardingContract.email. Decides the sign-in method. */
  email: string;
  /** Pre-formatted via formatTrainingDate (training-date.ts), or null when the
   *  cycle has no in-person training date scheduled. Callers must check the
   *  raw date themselves (e.g. `cycle?.inPersonTrainingDate ? formatTrainingDate(...) : null`)
   *  rather than let formatTrainingDate's own "the scheduled training date"
   *  fallback paper over a null date: that fallback exists for prose contexts
   *  (contract preview) that always need some words, not for this module,
   *  which models "nothing true to say" as null throughout. */
  trainingDate: string | null;
  /** Pre-formatted via formatTrainingLocation (training-date.ts): "" when the
   *  cycle has no location, and carries its own leading space otherwise, so
   *  it concatenates directly after trainingDate. Ignored when trainingDate
   *  is null. */
  trainingLocation: string;
  /**
   * Whether an ACTIVE Person already exists for this applicant (see
   * lookupHasAccount in services/onboarding.ts), matched the same way
   * lookupStoredEpicId matches: by netId, else by contactEmail. Signing in
   * (SSO or the magic link) only works once a Person row exists, and
   * promoteContracts -- a separate, later, permissioned action -- is the only
   * production path that creates one (services/promotion.ts). A contract
   * fresh off SUBMITTED has not been through it, so this is false for every
   * brand-new volunteer at submit time and at first revisit; it is true for a
   * returning member whose existing membership already lets them sign in.
   * Gates `signIn.text` only; `signIn.emailText` is unconditional (see its
   * doc comment above) because the email cannot know whether this will still
   * be accurate by the time it is opened.
   */
  hasAccount: boolean;
  /**
   * OnboardingContract.epicNeeded -- NOT the raw department/track
   * epicRequirement. epicRequirement collapses to the same answer for ALL
   * and NONE, but for SOME it depends entirely on the applicant's answer to
   * the required "epic_needed_self" question (resolveEpicNeeded in
   * epic-requirement.ts; the department, e.g. SRHD, really does use SOME).
   * promoteContracts only ever creates an EpicRequest when
   * `contract.epicNeeded && !effectiveEpicId` (promotion.ts), so gating this
   * copy on epicRequirement instead of epicNeeded would promise IT follow-up
   * to a SOME-department volunteer who answered "no" and will never get one.
   * Callers: the revisit page and the submit-time email both have
   * `contract.epicNeeded` as a persisted column already; the completion
   * screen can call the same `resolveEpicNeeded(ctx.epicRequirement,
   * answers.epic_needed_self === "yes")` the server uses, since it is a pure
   * function safe to run client-side.
   */
  epicNeeded: boolean;
  /** An Epic ID already on file for this person (lookupStoredEpicId), or null. */
  storedEpicId: string | null;
  /**
   * Whether the applicant checked "I already have a Yale Epic account" and
   * supplied an existingEpicId on the contract's Epic block. This ALSO
   * suppresses any EpicRequest at promotion regardless of epicNeeded:
   * promotion.ts derives `effectiveEpicId = person.epicId ?? contract.
   * existingEpicId`, so a self-reported existing ID is adopted onto the
   * Person record directly and no request (and so no follow-up email) is
   * ever queued for it. Ignored when storedEpicId is set (that state never
   * shows the checkbox).
   */
  hasEpic: boolean;
  /**
   * Whether a recruitment lead has already reviewed this submission and added
   * the volunteer to the roster -- i.e. OnboardingContract.status ===
   * "PROMOTED". promoteContracts IS that review-and-roster-add action (it
   * requires recruitment.review_all and does the TermMembership work at
   * promotion.ts:191-213), so once a contract is PROMOTED the review line
   * must read in the past tense: telling an already-accepted, already-
   * scheduled volunteer that a lead "will" still review them is the same
   * confusion this content module exists to remove. Optional and defaulting
   * to false so existing callers (the completion screen and the submit-time
   * email, both of which only ever see a freshly-SUBMITTED contract that
   * cannot yet be PROMOTED) do not need to pass it.
   */
  reviewed?: boolean;
};

function isYaleEmail(email: string): boolean {
  return email.trim().toLowerCase().endsWith("@yale.edu");
}

export function buildOnboardingNextSteps(input: OnboardingNextStepsInput): OnboardingNextSteps {
  const isYale = isYaleEmail(input.email);
  const method: SignInMethod = isYale ? "sso" : "magic-link";
  // The present-tense line is only true once a Person exists to sign in as
  // (hasAccount); otherwise it is the exact false promise this fix removes,
  // so suppress it entirely rather than tell a brand-new volunteer to sign in
  // to nothing.
  const text = input.hasAccount
    ? (isYale
        ? "Sign in with your Yale NetID."
        : "Enter your email on the sign-in page and we will email you a one-time sign-in link.")
    : null;
  // Phrased against the future roster-add (not the current hasAccount state)
  // because the confirmation email is a durable record read at an unknown
  // later time; see the doc comment on OnboardingNextSteps.signIn.emailText.
  const emailText = isYale
    ? "Once a recruitment lead adds you to the roster, sign in with your Yale NetID."
    : "Once a recruitment lead adds you to the roster, enter your email on the sign-in page and we will email you a one-time sign-in link.";
  const signIn: OnboardingNextSteps["signIn"] = { method, text, emailText };

  // Null (not a degraded-but-truthy fallback string) when the cycle has no
  // in-person training date: there is nothing true to promise about a session
  // that has not been scheduled.
  const training = input.trainingDate
    ? `Plan to attend in-person training on ${input.trainingDate}${input.trainingLocation}.`
    : null;

  let epic: string | null = null;
  if (input.storedEpicId) {
    epic = "Your Epic ID is already on file, so there is nothing more to do for Epic access.";
  } else if (input.hasEpic) {
    // No EpicRequest is ever created for this case (see the hasEpic doc
    // comment above), so no IT follow-up email is promised here either.
    epic = "The Epic ID you provided will be added to your account, so there is nothing more to do for Epic access right now.";
  } else if (input.epicNeeded) {
    epic = "The IT team will set up your Epic account and email you sign-in instructions once it is ready.";
  }

  // Same fact, conjugated for whether it has already happened (PROMOTED) or
  // is still pending (SUBMITTED). Not a new claim: promoteContracts is the
  // review-and-roster-add, so "reviewed" states only what the system already
  // did.
  const review = input.reviewed
    ? "A recruitment lead has reviewed your submission and added you to the roster."
    : "A recruitment lead will review your submission and add you to the roster.";

  return { loginPath: "/login", signIn, training, epic, review };
}
