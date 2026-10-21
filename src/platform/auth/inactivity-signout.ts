/**
 * The inactivity auto-logout's sign-out, retried until it lands.
 *
 * The 30-minute timer often fires the moment a laptop wakes, before the wifi
 * reconnects. next-auth's signOut then cannot reach /api/auth/csrf or
 * /api/auth/signout, logs "AuthError: Failed to fetch", and rejects. The
 * session cookie lives for 7 days, so nothing on the server ends the session
 * in its place: one failed attempt leaves the member signed in on a device
 * they walked away from.
 *
 * So the sign-out does not give up. It waits while the browser reports
 * offline, and after a failed attempt it tries again when the network comes
 * back, when the tab is shown again, and on a short interval. A successful
 * signOut navigates to /login, which ends the loop.
 */

export const SIGN_OUT_RETRY_MS = 15 * 1000;

/** Starts the sign-out loop. Returns a function that stops it. */
export function signOutUntilDone(signOut: () => Promise<unknown>): () => void {
  let inFlight = false;
  let done = false;

  const attempt = () => {
    if (done || inFlight || !navigator.onLine) return;
    inFlight = true;
    signOut().then(
      () => {
        done = true;
        stop();
      },
      () => {
        inFlight = false;
      },
    );
  };

  const onVisibilityChange = () => {
    if (document.visibilityState === "visible") attempt();
  };

  const interval = setInterval(attempt, SIGN_OUT_RETRY_MS);
  window.addEventListener("online", attempt);
  document.addEventListener("visibilitychange", onVisibilityChange);

  function stop() {
    clearInterval(interval);
    window.removeEventListener("online", attempt);
    document.removeEventListener("visibilitychange", onVisibilityChange);
  }

  attempt();
  return stop;
}
