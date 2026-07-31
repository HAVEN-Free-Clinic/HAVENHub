"use client";

import { useEffect } from "react";
import posthog from "posthog-js";
import { decideCrashRecovery } from "./router-hook-crash";

/**
 * Reloads the client once when React's hook-list corruption kills Next's App
 * Router root. See `router-hook-crash.ts` for the diagnosis and for when this
 * whole workaround should be deleted.
 *
 * Renders nothing; mounted from the root layout so it covers public routes too.
 */

/** Marks that this tab has already spent its one reload (see `CrashRecovery`). */
const RECOVERED_KEY = "haven:router-hook-crash-recovered";

function alreadyRecovered(): boolean {
  try {
    return sessionStorage.getItem(RECOVERED_KEY) !== null;
  } catch {
    // Storage is unavailable (Safari can throw here), so we cannot tell a first
    // crash from a second one. Claim we already recovered: a missed reload is a
    // page the member reloads by hand, an unbounded one is a reload loop.
    return true;
  }
}

function markRecovered(): boolean {
  try {
    sessionStorage.setItem(RECOVERED_KEY, "1");
    return true;
  } catch {
    return false;
  }
}

let installed = false;

function installOnce(): void {
  if (installed) return;
  installed = true;

  // Deliberately never removed. The crash tears the React tree down and swaps in
  // Next's DefaultGlobalError, so a listener tied to this component's lifetime
  // could be cleaned up in the very commit that needs it.
  window.addEventListener("error", (event) => {
    const decision = decideCrashRecovery(
      event.error ?? event.message,
      alreadyRecovered(),
    );
    if (decision !== "reload") return;
    if (!markRecovered()) return;

    // posthog-js has already filed the $exception itself; this says the member
    // was put back on their feet, which is what tells us whether the workaround
    // is earning its keep. No URL property of our own: posthog-js attaches
    // $current_url and `sanitize_properties` scrubs it (see scrub-url.ts).
    // It rides out on posthog-js's unload flush alongside that $exception, which
    // is how the crashes we have already seen reached Error Tracking at all.
    posthog.capture("client_router_crash_recovered");
    window.location.reload();
  });
}

export function RouterCrashRecovery() {
  useEffect(installOnce, []);
  return null;
}
