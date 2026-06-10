"use client";

import { useEffect, useState } from "react";
import { signOut } from "next-auth/react";

const TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const WARNING_MS = 5 * 60 * 1000;  // warn 5 minutes before logout

/**
 * Signs the user out after 30 minutes of inactivity.
 * Shows a warning banner 2 minutes before logout so the user can stay logged in.
 *
 * `authenticated` is resolved on the server (via `auth()` in the root layout)
 * and passed in as a prop, so this works without a SessionProvider.
 */
export function InactivityTracker({ authenticated }: { authenticated: boolean }) {
  const [showWarning, setShowWarning] = useState(false);

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

    const events = ["mousedown", "keydown", "scroll", "touchstart", "click"];
    events.forEach((e) => window.addEventListener(e, reset));
    reset();

    return () => {
      clearTimeout(logoutTimer);
      clearTimeout(warningTimer);
      events.forEach((e) => window.removeEventListener(e, reset));
    };
  }, [authenticated]);

  if (!showWarning) return null;

  return (
    <div className="fixed bottom-4 right-4 z-50 max-w-sm rounded-xl border border-amber-200 bg-amber-50 px-5 py-4 shadow-lg">
      <p className="text-sm font-semibold text-amber-800 mb-1">Still there?</p>
      <p className="text-sm text-amber-700 mb-3">
        You'll be signed out in 5 minutes due to inactivity.
      </p>
      <button
        onClick={() => setShowWarning(false)}
        className="rounded-lg bg-amber-800 px-4 py-1.5 text-sm font-medium text-white hover:bg-amber-900 transition-colors"
      >
        Stay signed in
      </button>
    </div>
  );
}