"use client";

import { useFormStatus } from "react-dom";

/**
 * Submit button for the "Sign in with Yale" form. Lives in its own client
 * component so it can read useFormStatus() and show a pending state while the
 * server action runs the OAuth redirect (which is otherwise silent on slow
 * connections, inviting double-taps).
 */
export function SignInButton() {
  const { pending } = useFormStatus();

  return (
    <button
      type="submit"
      disabled={pending}
      aria-busy={pending}
      className="flex w-full items-center justify-center gap-2 rounded-lg bg-brand px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-brand-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand disabled:cursor-not-allowed disabled:opacity-80"
    >
      {pending && (
        <svg
          aria-hidden="true"
          className="h-4 w-4 animate-spin"
          viewBox="0 0 24 24"
          fill="none"
        >
          <circle
            className="opacity-25"
            cx="12"
            cy="12"
            r="10"
            stroke="currentColor"
            strokeWidth="4"
          />
          <path
            className="opacity-90"
            fill="currentColor"
            d="M4 12a8 8 0 0 1 8-8v4a4 4 0 0 0-4 4H4z"
          />
        </svg>
      )}
      {pending ? "Signing in…" : "Sign in with Yale"}
    </button>
  );
}
