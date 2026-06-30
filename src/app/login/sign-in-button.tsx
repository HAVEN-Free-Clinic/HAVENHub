"use client";

import { useFormStatus } from "react-dom";
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
    // eslint-disable-next-line no-restricted-syntax -- full-width branded OAuth submit with Spinner, custom padding and opacity differ from Button primitive
    <button type="submit" disabled={pending} aria-busy={pending} className="flex w-full items-center justify-center gap-2 rounded-lg bg-brand px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-brand-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand disabled:cursor-not-allowed disabled:opacity-80">
      {pending && <Spinner size="sm" />}
      {pending ? "Signing in…" : "Sign in with Yale"}
    </button>
  );
}
