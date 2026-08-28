import posthog from "posthog-js";
import type { CrashRecovery } from "./router-hook-crash";

/**
 * The one-reload self-heal shared by the two fatal client errors we cannot fix
 * from application code: the App Router hook-list crash
 * (router-crash-recovery.tsx) and the chunk-load failure
 * (chunk-load-recovery.tsx). Both strand the member on a dead page, and for both
 * a single reload is the only recovery, so both reload once and record that they
 * did. See each sibling detection module for its own diagnosis.
 */
export type SelfHeal = {
  /** Decide what to do about an error the global handler saw. */
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
   * does not.
   */
  watchRejections?: boolean;
};

/** storageKeys already wired up, so a double mount (React strict mode) adds no second listener. */
const installed = new Set<string>();

export function installReloadOnce(heal: SelfHeal): void {
  if (installed.has(heal.storageKey)) return;
  installed.add(heal.storageKey);

  function alreadyRecovered(): boolean {
    try {
      return sessionStorage.getItem(heal.storageKey) !== null;
    } catch {
      // Storage is unavailable (Safari can throw here), so we cannot tell a
      // first crash from a second one. Claim we already recovered: a missed
      // reload is a page the member reloads by hand, an unbounded one is a loop.
      return true;
    }
  }

  function recover(error: unknown): void {
    if (heal.decide(error, alreadyRecovered()) !== "reload") return;
    try {
      sessionStorage.setItem(heal.storageKey, "1");
    } catch {
      return;
    }
    // posthog-js has already filed the $exception itself; this records that the
    // member was put back on their feet, which is what tells us the self-heal is
    // earning its keep. No URL property of our own: posthog-js attaches
    // $current_url and `sanitize_properties` scrubs it (see scrub-url.ts). It
    // rides out on posthog-js's unload flush alongside that $exception, which is
    // how the crashes we have already seen reached Error Tracking at all.
    posthog.capture(heal.recoveredEvent);
    window.location.reload();
  }

  // Deliberately never removed. A crash can tear the React tree down and swap in
  // Next's DefaultGlobalError, so a listener tied to a component's lifetime could
  // be cleaned up in the very commit that needs it.
  window.addEventListener("error", (event) => recover(event.error ?? event.message));
  if (heal.watchRejections) {
    window.addEventListener("unhandledrejection", (event) => recover(event.reason));
  }
}
