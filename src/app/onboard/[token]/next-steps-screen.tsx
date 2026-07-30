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
 */
export function NextStepsScreen({ steps }: { steps: OnboardingNextSteps }) {
  return (
    <div className="mt-8 space-y-6">
      <Alert tone="success">Thanks, your onboarding is complete.</Alert>
      <Card className="space-y-4">
        <h2 className="text-lg font-semibold text-foreground">What happens next</h2>
        <ul className="list-disc space-y-2 pl-5 text-sm text-foreground-soft">
          <li>{steps.signIn.text}</li>
          <li>{steps.training}</li>
          {steps.epic && <li>{steps.epic}</li>}
          <li>{steps.review}</li>
        </ul>
        <Link href={steps.loginPath} className={buttonClasses("primary", "lg", "w-full sm:w-auto")}>
          Sign in to HAVEN Hub
        </Link>
      </Card>
    </div>
  );
}
