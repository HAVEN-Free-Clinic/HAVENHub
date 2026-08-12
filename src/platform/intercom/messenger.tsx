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

export type IntercomMessengerMode = "identified" | "visitor";

/**
 * Boots the Intercom Messenger, in one of two modes -- one component, not a
 * fork per surface, because the two modes share every timing and cleanup
 * concern below and only differ in what they hand Intercom:
 *
 *   - "identified" mints a signed identity-verification JWT from the caller's
 *     session (see jwt.ts) and keeps it fresh for the life of the tab. This is
 *     the only mode that can ever attach a Person's identity to the Messenger;
 *     nothing here decides WHO gets identified, that is entirely the token
 *     route's call (see messenger-token/route.ts) -- this component only ever
 *     asks and reacts to the answer.
 *   - "visitor" calls `Intercom({ app_id })` with no JWT and no user_id at
 *     all, which Intercom boots as an anonymous contact. No token, no fetch,
 *     no refresh loop -- there is nothing to keep fresh.
 *
 * `requireActiveMembership` is forwarded to the token route as a request flag,
 * not evaluated here: it tells the route to also require a current ACTIVE term
 * membership before minting (the /apply portal's rule -- see the route's doc
 * comment for why the hub does not carry the same restriction). Whatever the
 * route decides, this component just reacts: a refusal (401 = no session/no
 * eligible Person, 403 = signed in but the membership check failed) before the
 * first successful boot settles the tab into visitor mode. That is the correct
 * steady state for an applicant or a bare Yale account with no Person -- not a
 * degraded fallback, the designed answer -- so it is terminal for the tab
 * rather than something to keep retrying.
 */
export function IntercomMessenger({
  appId,
  mode,
  requireActiveMembership = false,
}: {
  appId: string;
  mode: IntercomMessengerMode;
  /** Only meaningful when mode is "identified". See the doc comment above. */
  requireActiveMembership?: boolean;
}) {
  useEffect(() => {
    if (mode === "visitor") {
      Intercom({ app_id: appId });
      return () => shutdown();
    }

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let booted = false;

    const scheduleIn = (seconds: number) => {
      if (cancelled) return;
      timer = setTimeout(() => void load(), seconds * 1000);
    };

    const tokenUrl = requireActiveMembership
      ? `${MESSENGER_TOKEN_PATH}?requireActiveMembership=1`
      : MESSENGER_TOKEN_PATH;

    async function load(): Promise<void> {
      if (cancelled) return;

      let token: string | undefined;
      let ttl = INTERCOM_FALLBACK_TTL_SECONDS;
      try {
        const res = await fetch(tokenUrl, { cache: "no-store" });
        if (!res.ok) {
          // 404 means the integration is switched off server-side, so there is
          // nothing to wait for.
          if (res.status === 404) return;
          // 401 (no session, or a session that resolves to no eligible Person)
          // and 403 (a Person, but requireActiveMembership failed) are both
          // permanent answers for THIS boot, not transient faults -- retrying
          // them on a timer would just relearn the same thing every 60s while
          // showing no support widget at all. Settle into visitor instead, but
          // only before the first successful identified boot: a mid-session
          // 401/403 after that (session revoked under an open tab) keeps the
          // existing retry behavior rather than yanking an open conversation
          // over to an anonymous one.
          if ((res.status === 401 || res.status === 403) && !booted) {
            Intercom({ app_id: appId });
            booted = true;
            return;
          }
          scheduleIn(RETRY_DELAY_SECONDS);
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
  }, [appId, mode, requireActiveMembership]);

  return null;
}
