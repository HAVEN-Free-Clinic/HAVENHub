"use client";
import { useFormStatus } from "react-dom";
import { portalYaleSignInAction } from "./portal-actions";
import { Button } from "@/platform/ui/button";
import { Spinner } from "@/platform/ui/spinner";

/**
 * "Sign in with Yale" for the applicant portal. Submits straight to the Entra
 * sign-in, so the next screen an applicant sees is Microsoft's rather than the
 * hub's staff login page.
 *
 * A client component for two reasons: the OAuth redirect is silent on a slow
 * connection and invites double-taps, so the pending state matters; and the
 * apply wizard is itself "use client", so only a shared component lets both
 * call sites render the same control.
 */
export function YaleSignInButton({ next, className }: { next: string; className?: string }) {
  return (
    <form action={portalYaleSignInAction} className={className}>
      <input type="hidden" name="next" value={next} />
      <SubmitButton />
    </form>
  );
}

// Split out so it can read useFormStatus(), which only reports the status of an
// ancestor form.
function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" size="lg" disabled={pending} aria-busy={pending} className="w-full gap-2">
      {pending && <Spinner size="sm" />}
      {pending ? "Signing in..." : "Sign in with Yale"}
    </Button>
  );
}
