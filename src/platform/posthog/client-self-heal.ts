import posthog from "posthog-js";
import type { CrashRecovery } from "./router-hook-crash";

/**
 * The one-reload self-heal shared by the client errors we cannot fix from
 * application code: the App Router hook-list crash (router-crash-recovery.tsx),
 * the chunk-load failure (chunk-load-recovery.tsx), and the stale Server Action
 * id (stale-server-action.ts). Each strands the member on a page that cannot be
 * used, and for each a single reload is the only recovery, so each reloads once
 * and records that it did. See each sibling detection module for its own
 * diagnosis.
 */
export type SelfHeal = {
  /** Decide what to do about an error. */
  decide: (error: unknown, alreadyRecovered: boolean) => CrashRecovery;
  /**
   * sessionStorage key marking that this tab has spent its one reload. Each
   * crash gets its own key, so recovering from one never spends the other's
   * reload.
   */
  storageKey: string;
  /** posthog event filed when the reload fires, so we can see the heal work. */
  recoveredEvent: string;
  /**
   * Also watch promise rejections. A failed dynamic import rejects rather than
   * throwing, so the chunk-load self-heal needs this; the synchronous hook crash
   * does not. Only meaningful to `installReloadOnce`.
   */
  watchRejections?: boolean;
};

function alreadyRecovered(storageKey: string): boolean {
  try {
    return sessionStorage.getItem(storageKey) !== null;
  } catch {
    // Storage is unavailable (Safari can throw here), so we cannot tell a
    // first crash from a second one. Claim we already recovered: a missed
    // reload is a page the member reloads by hand, an unbounded one is a loop.
    return true;
  }
}

/**
 * Reload the tab once for this error, if this heal recognises it and this tab
 * has not already spent its reload. Returns whether the reload was started, so
 * a caller that has its own UI can say "reloading" rather than "try again".
 *
 * The imperative half of the self-heal, for errors that never reach a global
 * handler because application code already caught them -- a rejected Server
 * Action inside a form's own try/catch is the case this exists for. The
 * listener-driven half is `installReloadOnce` below; both go through here, so a
 * crash cannot spend its one reload twice by arriving down both paths.
 */
export function recoverOnce(heal: SelfHeal, error: unknown): boolean {
  if (typeof window === "undefined") return false;
  if (heal.decide(error, alreadyRecovered(heal.storageKey)) !== "reload") return false;
  try {
    sessionStorage.setItem(heal.storageKey, "1");
  } catch {
    return false;
  }
  // posthog-js has already filed the $exception itself where the error reached a
  // global handler; this records that the member was put back on their feet,
  // which is what tells us the self-heal is earning its keep. No URL property of
  // our own: posthog-js attaches $current_url and `sanitize_properties` scrubs
  // it (see scrub-url.ts). It rides out on posthog-js's unload flush alongside
  // that $exception, which is how the crashes we have already seen reached Error
  // Tracking at all.
  posthog.capture(heal.recoveredEvent);
  window.location.reload();
  return true;
}

/** storageKeys already wired up, so a double mount (React strict mode) adds no second listener. */
const installed = new Set<string>();

export function installReloadOnce(heal: SelfHeal): void {
  if (installed.has(heal.storageKey)) return;
  installed.add(heal.storageKey);

  // Deliberately never removed. A crash can tear the React tree down and swap in
  // Next's DefaultGlobalError, so a listener tied to a component's lifetime could
  // be cleaned up in the very commit that needs it.
  window.addEventListener("error", (event) =>
    recoverOnce(heal, event.error ?? event.message),
  );
  if (heal.watchRejections) {
    window.addEventListener("unhandledrejection", (event) =>
      recoverOnce(heal, event.reason),
    );
  }
}
