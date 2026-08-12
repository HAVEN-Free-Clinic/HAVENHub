"use client";

import { useEffect, useRef } from "react";
import Intercom, { shutdown, update } from "@intercom/messenger-js-sdk";

/**
 * Refresh this far ahead of expiry. Wide enough to absorb a slow request or a
 * briefly-offline laptop without the token lapsing mid-conversation.
 */
const REFRESH_MARGIN_SECONDS = 5 * 60;

/** Retry delay after a failed mint, so one 503 does not kill support for the tab. */
const RETRY_DELAY_SECONDS = 60;

/** Only used if the route ever omits the TTL; keeps the refresh loop alive. */
const INTERCOM_FALLBACK_TTL_SECONDS = 15 * 60;

/**
 * Deliberately does NOT contain the word "intercom".
 *
 * Ad blockers match on URL substrings, so a first-party path like
 * /api/intercom/token is blocked by mainstream filter lists exactly as if it
 * were a third-party tracker -- observed in practice, as Chrome reporting
 * `(blocked:other)` against our own origin. The Messenger itself still loads
 * from widget.intercom.io and is blockable no matter what we do, but there is
 * no reason to hand the filter lists our own endpoint as well. Do not rename
 * this back.
 */
const MESSENGER_TOKEN_PATH = "/api/support/messenger-token";

/**
 * Boots the Intercom Messenger for the signed-in person with an identity
 * verification JWT, and keeps that token fresh for the life of the tab.
 *
 * The token is fetched (rather than only passed as a prop) so it can be
 * re-minted: a hub tab can outlive a short-lived JWT by many hours, and
 * Intercom rejects every request once it expires. Refreshing hands the new
 * token to `update`, which avoids tearing down an open conversation the way a
 * re-boot would.
 *
 * Mounted only from the (app) layout, so the Messenger is scoped to
 * authenticated hub routes and never boots on the public apply portal.
 */
export function IntercomMessenger({
  appId,
  initialToken,
}: {
  appId: string;
  /**
   * Minted during the server render so the widget script can start loading the
   * moment React hydrates, instead of after a round trip and the token route's
   * database queries.
   *
   * Optional and nullable on purpose: a server mint legitimately returns
   * nothing when the integration is off, the session resolves to no active
   * Person, or the database is briefly unreachable. In each case this falls
   * back to fetching rather than receiving a fabricated token.
   */
  initialToken?: { token: string; expiresInSeconds: number } | null;
}) {
  // Freeze the token this instance boots with. The effect below only ever
  // needs the FIRST token; every later one comes from its own fetch loop and
  // is handed over with `update`.
  //
  // This is not just an object-identity guard. mintIntercomUserJwt calls
  // .setIssuedAt(), so the STRING itself is different on every mint, not just
  // its wrapper object. A live prop dependency (even `initialToken?.token`)
  // would re-run this effect on every server re-render of the layout that
  // re-mints -- a router.refresh(), a revalidating Server Action -- tearing
  // down a live conversation via cleanup's shutdown() and then re-booting
  // from a fresh closure with `booted` reset to false. useRef's initializer
  // only runs once, on mount, so bootTokenRef.current can never change across
  // renders and the effect has nothing to depend on but `appId`.
  const bootTokenRef = useRef(initialToken);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let booted = false;

    const scheduleIn = (seconds: number) => {
      if (cancelled) return;
      timer = setTimeout(() => void load(), seconds * 1000);
    };

    /** Boot once, then hand over later tokens with `update`. */
    const applyToken = (token: string) => {
      if (booted) {
        update({ intercom_user_jwt: token });
        return;
      }
      Intercom({ app_id: appId, intercom_user_jwt: token });
      booted = true;
    };

    async function load(): Promise<void> {
      if (cancelled) return;

      let token: string | undefined;
      let ttl = INTERCOM_FALLBACK_TTL_SECONDS;
      try {
        const res = await fetch(MESSENGER_TOKEN_PATH, { cache: "no-store" });
        if (!res.ok) {
          // 404 means the integration is switched off server-side, so there is
          // nothing to wait for. Anything else (401 mid-session, 503 DB blip)
          // is transient and worth another try.
          if (res.status !== 404) scheduleIn(RETRY_DELAY_SECONDS);
          return;
        }
        const payload = await res.json();
        token = typeof payload?.token === "string" ? payload.token : undefined;
        if (Number.isFinite(payload?.expiresInSeconds)) ttl = payload.expiresInSeconds;
      } catch {
        scheduleIn(RETRY_DELAY_SECONDS);
        return;
      }

      if (cancelled || !token) {
        if (!cancelled) scheduleIn(RETRY_DELAY_SECONDS);
        return;
      }

      applyToken(token);
      scheduleIn(Math.max(ttl - REFRESH_MARGIN_SECONDS, RETRY_DELAY_SECONDS));
    }

    const bootToken = bootTokenRef.current;
    if (bootToken) {
      // The fast path. applyToken sets `booted`, so the refresh below goes
      // through `update` and does not re-boot the widget under an open
      // conversation.
      applyToken(bootToken.token);
      scheduleIn(Math.max(bootToken.expiresInSeconds - REFRESH_MARGIN_SECONDS, RETRY_DELAY_SECONDS));
    } else {
      void load();
    }

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      // Clear the Intercom session and its cookies on unmount. Without this a
      // sign-out (or switching accounts in the same browser) would leave the
      // previous member's support session live for the next person.
      shutdown();
    };
    // bootTokenRef is a ref object: reading .current inside the effect does
    // not need to appear in the dependency array, so appId is the only real
    // dependency.
  }, [appId]);

  return (
    <>
      {/* Rendered here rather than in a layout so every surface that mounts the
          Messenger gets them. React hoists these into <head>. They cut DNS and
          the TLS handshake off the widget script's critical path. */}
      <link rel="preconnect" href="https://widget.intercom.io" />
      <link rel="preconnect" href="https://js.intercomcdn.com" crossOrigin="anonymous" />
    </>
  );
}
