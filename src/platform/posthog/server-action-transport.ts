/**
 * Recognise a Server Action whose RESPONSE was not a Server Action response, so
 * the client reloads once instead of offering a retry that posts into the same
 * broken transport.
 *
 * The failure. Next's `fetchServerAction` requires the response to carry
 * `content-type: text/x-component` (or be an external redirect). When it does
 * not -- an HTML error page from the platform or a proxy, a 502/504 gateway
 * page, an edge redirect to a sign-in page -- Next throws a plain Error from
 * `server-action-reducer.ts`. That throw is not caught by anything of ours, so
 * React routes it to the nearest error boundary, which offers "Try again".
 *
 * What we saw. Error Tracking issue 01a017d1 recorded 5 of these across 2
 * members on Aug 18-19, every event on `/my-info`, every one `handled: true`
 * with a single resolved frame at `fetchServerAction`
 * (`next/src/client/components/router-reducer/reducers/server-action-reducer.ts`).
 * Both members retried -- 13 seconds apart in one session, 63 in the other --
 * which is the same dead-end shape as the stale action id in
 * `stale-server-action.ts`, arriving one layer lower down: there the server did
 * not recognise the action, here the response never came back as one.
 *
 * Why the message and not an error code. Next stamps `__NEXT_ERROR_CODE` on this
 * throw, but that code is `E394`, which appears 252 times across `next/dist` --
 * `client/components/redirect.js` among them. Keying on it would swallow
 * redirects, so it is unusable as a discriminator and the message is the only
 * signal left. Matched EXACTLY, not by substring, and only the generic sentence:
 * the same branch substitutes the server's own `text/plain` body when the status
 * is >= 400, and that variant carries a real server message we want to keep
 * seeing in Error Tracking rather than quietly reload past.
 *
 * That makes this the most brittle predicate in the self-heal family, which is
 * why `server-action-transport.test.ts` pins the sentence: if a `next` upgrade
 * rewords it the test still passes (it asserts our own constant) but the recovery
 * silently stops firing, so the constant is duplicated from Next deliberately and
 * the test documents where to re-check it. The cost of a miss is the status quo
 * -- a member on a "Try again" screen -- not a regression.
 */

import type { CrashRecovery } from "./router-hook-crash";
import type { SelfHeal } from "./client-self-heal";

/**
 * Next's generic wording when a Server Action response is not RSC and is not a
 * redirect. Copied verbatim from
 * `next/dist/client/components/router-reducer/reducers/server-action-reducer.js`
 * (next 16.2.11); re-check on a major `next` upgrade.
 */
export const UNEXPECTED_ACTION_RESPONSE_MESSAGE =
  "An unexpected response was received from the server.";

/**
 * True when a rejection is Next refusing a Server Action response it could not
 * read as one.
 *
 * Exact equality, not `includes`: a substring test would also match an
 * application error that quotes the sentence, and this predicate spends a page
 * reload.
 */
export function isServerActionTransportError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const { message } = error as { message?: unknown };
  return message === UNEXPECTED_ACTION_RESPONSE_MESSAGE;
}

export function decideServerActionTransportRecovery(
  error: unknown,
  alreadyRecovered: boolean,
): CrashRecovery {
  if (!isServerActionTransportError(error)) return "unrelated";
  // A second one in the same tab means the reload did not clear whatever was
  // answering for the action, so reloading again would only loop.
  return alreadyRecovered ? "already-recovered" : "reload";
}

/** Its own storage key, so this reload is not spent by a different crash class. */
export const SERVER_ACTION_TRANSPORT_HEAL: SelfHeal = {
  decide: decideServerActionTransportRecovery,
  storageKey: "haven:server-action-transport-recovered",
  recoveredEvent: "client_server_action_transport_recovered",
  watchRejections: true,
};
