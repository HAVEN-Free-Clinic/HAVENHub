import Link from "next/link";
import { Alert } from "@/platform/ui/alert";
import { Card } from "@/platform/ui/card";
import { buttonClasses } from "@/platform/ui/button";
import type { OnboardingNextSteps } from "@/modules/recruitment/onboarding-next-steps";

/**
 * Replaces the bare "thanks, we'll be in touch" acknowledgement that used to
 * be the entire completion screen. Renders Task 1's shared next-steps content
 * verbatim (buildOnboardingNextSteps) so this screen, the revisit page, and
 * the confirmation email never drift from one another -- no copy is authored
 * here beyond section structure.
 *
 * signIn.text (and the button below it) are null/omitted when the volunteer
 * has no Person to sign in as yet (hasAccount false in the input): there is
 * nothing true to tell them about signing in, and nothing to click through
 * to, so the review bullet alone carries the sequencing instead.
 */
export function NextStepsScreen({ steps }: { steps: OnboardingNextSteps }) {
  return (
    <div className="mt-8 space-y-6">
      <Alert tone="success">Thanks, your onboarding is complete.</Alert>
      <Card className="space-y-4">
        <h2 className="text-lg font-semibold text-foreground">What happens next</h2>
        <ul className="list-disc space-y-2 pl-5 text-sm text-foreground-soft">
          {steps.signIn.text && <li>{steps.signIn.text}</li>}
          {steps.training && <li>{steps.training}</li>}
          {steps.epic && <li>{steps.epic}</li>}
          <li>{steps.review}</li>
        </ul>
        {steps.signIn.text && (
          <Link href={steps.loginPath} className={buttonClasses("primary", "lg", "w-full sm:w-auto")}>
            Sign in to HAVEN Hub
          </Link>
        )}
      </Card>
    </div>
  );
}
