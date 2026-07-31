"use client";

import { useEffect, useRef, useState } from "react";
import { signOut } from "next-auth/react";

const TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const WARNING_MS = 5 * 60 * 1000;  // warn 5 minutes before logout

/**
 * Signs the user out after 30 minutes of inactivity.
 * Shows a warning banner 5 minutes before logout so the user can stay logged in.
 *
 * `authenticated` is resolved on the server (via `auth()` in the root layout)
 * and passed in as a prop, so this works without a SessionProvider: the timer
 * only runs for signed-in users and is a no-op on the login page.
 */
export function InactivityTracker({ authenticated }: { authenticated: boolean }) {
  const [showWarning, setShowWarning] = useState(false);
  // Holds the latest timer-reset function so the "Stay signed in" button can
  // re-arm the timers directly instead of relying on event bubbling.
  const resetRef = useRef<() => void>(() => {});

  useEffect(() => {
    if (!authenticated) return;

    let logoutTimer: ReturnType<typeof setTimeout>;
    let warningTimer: ReturnType<typeof setTimeout>;

    const reset = () => {
      clearTimeout(logoutTimer);
      clearTimeout(warningTimer);
      setShowWarning(false);

      warningTimer = setTimeout(() => {
        setShowWarning(true);
      }, TIMEOUT_MS - WARNING_MS);

      logoutTimer = setTimeout(() => {
        signOut({ callbackUrl: "/login" });
      }, TIMEOUT_MS);
    };
    resetRef.current = reset;

    const events = ["mousedown", "keydown", "scroll", "touchstart", "click"];
    events.forEach((e) => window.addEventListener(e, reset));
    reset();

    return () => {
      clearTimeout(logoutTimer);
      clearTimeout(warningTimer);
      events.forEach((e) => window.removeEventListener(e, reset));
    };
  }, [authenticated]);

  // Derive visibility from the prop so the banner clears immediately if the
  // user de-authenticates while it is up, without syncing state in the effect.
  if (!authenticated || !showWarning) return null;

  return (
    // Shares the toast viewport's bottom-center lane (ToastViewport,
    // src/platform/ui/toast/toast.tsx) instead of its old bottom-4 right-4
    // corner, which collided with HelpLauncher's bubble there (R12). Both
    // mount as independent `fixed` elements in the root layout, so "share a
    // lane" here means matching its horizontal centering and sitting well
    // clear of it vertically, not a literal shared flex parent: bottom-48
    // (12rem) clears ToastViewport's tallest possible stack -- 3 toasts
    // (MAX_VISIBLE) at roughly 44px each plus two 8px gaps, atop its own
    // bottom-4 offset, is about 176px -- with margin to spare, so the two can
    // never overlap even when both are visible at once.
    <div
      role="alert"
      className="fixed inset-x-0 bottom-48 z-50 mx-auto w-fit max-w-sm rounded-xl border border-border bg-surface px-5 py-4 shadow-lg"
    >
      <p className="text-sm font-semibold text-foreground mb-1">Still there?</p>
      <p className="text-sm text-foreground-soft mb-3">
        You&apos;ll be signed out in 5 minutes due to inactivity.
      </p>
      <button
        onClick={() => resetRef.current()}
        className="rounded-lg bg-brand px-4 py-1.5 text-sm font-medium text-white hover:bg-brand-hover transition-colors"
      >
        Stay signed in
      </button>
    </div>
  );
}
