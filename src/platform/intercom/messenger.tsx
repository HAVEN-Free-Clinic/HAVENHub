"use client";

import { useEffect } from "react";
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
 * The token is fetched rather than passed as a prop so it can be re-minted: a
 * hub tab can outlive a short-lived JWT by many hours, and Intercom rejects
 * every request once it expires. Refreshing hands the new token to `update`,
 * which avoids tearing down an open conversation the way a re-boot would.
 *
 * Mounted only from the (app) layout, so the Messenger is scoped to
 * authenticated hub routes and never boots on the public apply portal.
 */
export function IntercomMessenger({ appId }: { appId: string }) {
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let booted = false;

    const scheduleIn = (seconds: number) => {
      if (cancelled) return;
      timer = setTimeout(() => void load(), seconds * 1000);
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

      if (booted) {
        update({ intercom_user_jwt: token });
      } else {
        Intercom({ app_id: appId, intercom_user_jwt: token });
        booted = true;
      }

      scheduleIn(Math.max(ttl - REFRESH_MARGIN_SECONDS, RETRY_DELAY_SECONDS));
    }

    void load();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      // Clear the Intercom session and its cookies on unmount. Without this a
      // sign-out (or switching accounts in the same browser) would leave the
      // previous member's support session live for the next person.
      shutdown();
    };
  }, [appId]);

  return null;
}
