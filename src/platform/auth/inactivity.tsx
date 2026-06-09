"use client";

import { useEffect } from "react";
import { signOut } from "next-auth/react";

const TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Signs the user out after 30 minutes of inactivity.
 *
 * `authenticated` is resolved on the server (via `auth()` in the root layout)
 * and passed in as a prop, so this works without a SessionProvider: the timer
 * only runs for signed-in users and is a no-op on the login page.
 */
export function InactivityTracker({ authenticated }: { authenticated: boolean }) {
  useEffect(() => {
    if (!authenticated) return;

    let timer: ReturnType<typeof setTimeout>;

    const reset = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        signOut({ callbackUrl: "/login" });
      }, TIMEOUT_MS);
    };

    const events = ["mousedown", "keydown", "scroll", "touchstart", "click"];
    events.forEach((e) => window.addEventListener(e, reset));
    reset();

    return () => {
      clearTimeout(timer);
      events.forEach((e) => window.removeEventListener(e, reset));
    };
  }, [authenticated]);

  return null;
}
