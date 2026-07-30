import type { EpicRequirement } from "@prisma/client";

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
  signIn: { method: SignInMethod; text: string };
  /** Always non-empty: formatTrainingDate/formatTrainingLocation already
   *  degrade to sensible defaults when the cycle has no training date or
   *  location set (see training-date.ts). */
  training: string;
  /** Null when this contract's department has no Epic requirement and no
   *  Epic ID is already on file for this person -- there is nothing to say. */
  epic: string | null;
  review: string;
};

export type OnboardingNextStepsInput = {
  /** OnboardingContract.email. Decides the sign-in method. */
  email: string;
  /** Pre-formatted via formatTrainingDate (training-date.ts). */
  trainingDate: string;
  /** Pre-formatted via formatTrainingLocation (training-date.ts): "" when the
   *  cycle has no location, and carries its own leading space otherwise, so
   *  it concatenates directly after trainingDate. */
  trainingLocation: string;
  /** The department/track-derived Epic requirement (epic-requirement.ts). */
  epicRequirement: EpicRequirement;
  /** An Epic ID already on file for this person (lookupStoredEpicId), or null. */
  storedEpicId: string | null;
  /** Whether the applicant checked "I already have a Yale Epic account" on
   *  the contract's Epic block. Ignored when storedEpicId is set (that state
   *  never shows the checkbox). */
  hasEpic: boolean;
};

function isYaleEmail(email: string): boolean {
  return email.trim().toLowerCase().endsWith("@yale.edu");
}

export function buildOnboardingNextSteps(input: OnboardingNextStepsInput): OnboardingNextSteps {
  const signIn: OnboardingNextSteps["signIn"] = isYaleEmail(input.email)
    ? { method: "sso", text: "Sign in with your Yale NetID." }
    : {
        method: "magic-link",
        text: "Enter your email on the sign-in page and we will email you a one-time sign-in link.",
      };

  const training = `Plan to attend in-person training on ${input.trainingDate}${input.trainingLocation}.`;

  let epic: string | null = null;
  if (input.storedEpicId) {
    epic = "Your Epic ID is already on file, so there is nothing more to do for Epic access.";
  } else if (input.epicRequirement !== "NONE") {
    epic = input.hasEpic
      ? "The IT team will update your existing Epic account and email you once it is ready."
      : "The IT team will set up your Epic account and email you sign-in instructions once it is ready.";
  }

  const review = "A recruitment lead will review your submission and add you to the roster.";

  return { loginPath: "/login", signIn, training, epic, review };
}
