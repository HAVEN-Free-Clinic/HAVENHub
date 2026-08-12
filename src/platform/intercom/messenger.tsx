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

export type IntercomMessengerMode = "identified" | "visitor";

/**
 * Boots the Intercom Messenger, in one of two modes -- one component, not a
 * fork per surface, because the two modes share every timing and cleanup
 * concern below and only differ in what they hand Intercom:
 *
 *   - "identified" attaches a signed identity-verification JWT (see jwt.ts) and
 *     keeps it fresh for the life of the tab. This is the only mode that can
 *     ever attach a Person's identity to the Messenger; nothing here decides
 *     WHO gets identified, that is entirely the mint's call (see
 *     modules/support/services/messenger-token.ts) -- this component only ever
 *     asks and reacts to the answer.
 *   - "visitor" calls `Intercom({ app_id })` with no JWT and no user_id at
 *     all, which Intercom boots as an anonymous contact. No token, no fetch,
 *     no refresh loop -- there is nothing to keep fresh.
 *
 * `requireActiveMembership` is forwarded to the token route as a request flag,
 * not evaluated here: it tells the server to also require a current ACTIVE term
 * membership before minting (the /apply portal's rule -- see the mint's doc
 * comment for why the hub does not carry the same restriction). Whatever the
 * server decides, this component just reacts: a refusal (401 = no session/no
 * eligible Person, 403 = signed in but the membership check failed) before the
 * first successful boot settles the tab into visitor mode. That is the correct
 * steady state for an applicant or a bare Yale account with no Person -- not a
 * degraded fallback, the designed answer -- so it is terminal for the tab
 * rather than something to keep retrying.
 *
 * THE ONE INVARIANT THIS FILE CANNOT ENFORCE: that 401/403 fallback is guarded
 * on `!booted`, and `initialToken` sets `booted` at mount. So on any surface
 * passing `initialToken`, the client-side fallback is unreachable by
 * construction -- it cannot fire, because the tab has already booted. That is
 * correct today only because (app)/layout.tsx is the sole caller passing one
 * and the hub has no membership gate. If `initialToken` is ever wired into a
 * surface that DOES gate (the /apply portal), the gate MUST run server-side at
 * mint time: this fallback will silently not run, and a stranger will boot
 * identified with nothing erroring anywhere. Stated again at the /apply call
 * site and in the mint itself, because no one of the three can enforce it.
 */
export function IntercomMessenger({
  appId,
  mode,
  requireActiveMembership = false,
  initialToken,
}: {
  appId: string;
  mode: IntercomMessengerMode;
  /** Only meaningful when mode is "identified". See the doc comment above. */
  requireActiveMembership?: boolean;
  /**
   * A token minted during the server render, so the widget can boot without
   * waiting for a round trip. Null or absent whenever the server declined to
   * mint (integration off, no active Person, database briefly unreachable) or
   * the surface never mints one; in every such case this falls back to fetching
   * rather than booting on a fabricated token.
   *
   * Meaningless in visitor mode, which boots with no token at all.
   */
  initialToken?: { token: string; expiresInSeconds: number } | null;
}) {
  // Freeze the token this instance boots with. The effect below only ever needs
  // the FIRST token; every later one comes from its own fetch loop and is
  // handed over with `update`.
  //
  // This is not merely an object-identity guard. mintIntercomUserJwt calls
  // .setIssuedAt(), so the STRING itself differs on every mint, not just its
  // wrapper object. A live prop dependency (even `initialToken?.token`) would
  // re-run this effect on every server re-render that re-mints -- a
  // router.refresh(), a revalidating Server Action -- tearing down a live
  // conversation via cleanup's shutdown() and re-booting from a fresh closure
  // with `booted` reset to false. useRef's initializer runs once, on mount, so
  // bootTokenRef.current cannot change across renders and the effect has
  // nothing to depend on but the scalars below.
  const bootTokenRef = useRef(initialToken);

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

    /**
     * Boot once, then hand over later tokens with `update`.
     *
     * The only place `booted` flips on a token boot, so the server-minted fast
     * path and the fetch path cannot diverge. Splitting them is how a refresh
     * becomes a second Intercom() call, re-booting the widget underneath an
     * open conversation instead of quietly swapping the token.
     */
    const applyToken = (token: string) => {
      if (booted) {
        update({ intercom_user_jwt: token });
        return;
      }
      Intercom({ app_id: appId, intercom_user_jwt: token });
      booted = true;
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
          //
          // Deliberately not routed through applyToken: this is the one boot
          // that carries no token.
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

      applyToken(token);
      scheduleIn(Math.max(ttl - REFRESH_MARGIN_SECONDS, RETRY_DELAY_SECONDS));
    }

    const bootToken = bootTokenRef.current;
    if (bootToken) {
      // The fast path. applyToken sets `booted`, so the refresh scheduled below
      // goes through `update` and does not re-boot the widget under an open
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
    // Every dependency here is a stable scalar. bootTokenRef is a ref object:
    // reading .current inside the effect does not belong in this array, and
    // putting the token in it (in any form) is the re-boot bug described above.
  }, [appId, mode, requireActiveMembership]);

  return (
    <>
      {/* Rendered here rather than in a layout so every surface that mounts the
          Messenger gets them, including the visitor-mode ones. React hoists
          these into <head>. They cut DNS and the TLS handshake off the widget
          script's critical path -- which matters most on a visitor surface like
          /login, where there is no session work to overlap them with and the
          script is the entire critical path. */}
      <link rel="preconnect" href="https://widget.intercom.io" />
      <link rel="preconnect" href="https://js.intercomcdn.com" crossOrigin="anonymous" />
    </>
  );
}
