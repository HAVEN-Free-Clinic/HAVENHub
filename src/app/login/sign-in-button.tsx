"use client";

import { useFormStatus } from "react-dom";
import { Button } from "@/platform/ui/button";
import { Spinner } from "@/platform/ui/spinner";

/**
 * Submit button for the "Sign in with Yale" form. Lives in its own client
 * component so it can read useFormStatus() and show a pending state while the
 * server action runs the OAuth redirect (which is otherwise silent on slow
 * connections, inviting double-taps).
 */
export function SignInButton() {
  const { pending } = useFormStatus();

  return (
    <Button type="submit" variant="primary" disabled={pending} aria-busy={pending} className="w-full gap-2">
      {pending && <Spinner size="sm" />}
      {pending ? "Signing in…" : "Sign in with Yale"}
    </Button>
  );
}
