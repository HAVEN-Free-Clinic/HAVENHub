/**
 * Recognise a Server Action call that a newer deploy has already replaced, so
 * the client reloads onto the new bundle instead of telling the member to retry
 * something that cannot succeed.
 *
 * The failure: a tab open across a deploy still holds the bundle it loaded, so
 * its forms post the action ids that bundle was built with. When a deploy
 * changes an action, the server no longer knows that id and Next throws
 * `UnrecognizedActionError`. We saw it on `/login`, from a bundle four commits
 * behind what production was serving; the member was told "Something went wrong.
 * Please try again", took that advice, and hit the same wall two seconds later,
 * because the stale bundle sends the same dead id every time.
 *
 * Unlike the sibling crashes, this one is usually CAUGHT: forms wrap their
 * action calls (see run-action.ts and login/member-sign-in-form.tsx), so it
 * never reaches a global handler. That is why the recovery is driven
 * imperatively through `recoverOnce` from those catch blocks, rather than by
 * `installReloadOnce`. The listener is still worth having for any call that is
 * not wrapped.
 *
 * Detection is Next's own `unstable_isUnrecognizedActionError`, not a message
 * match: Next builds this error itself, the predicate is the supported way to
 * ask, and the message text is not something we should be pinned to. It is
 * `unstable_` because the API may be renamed, not because the behaviour is in
 * doubt; `stale-server-action.test.ts` fails loudly if the export disappears in
 * a `next` upgrade.
 */

import { unstable_isUnrecognizedActionError } from "next/navigation";

import type { CrashRecovery } from "./router-hook-crash";
import type { SelfHeal } from "./client-self-heal";

/**
 * What the member is told while the reload runs. Replaces "try again" copy,
 * which is the one instruction that cannot work here: the retry re-sends the
 * same dead action id from the same stale bundle.
 */
export const STALE_DEPLOY_MESSAGE =
  "A new version of the Hub was just released. Reloading to catch up...";

/** True when a rejection is Next refusing an action id the running deploy no longer has. */
export function isStaleServerActionError(error: unknown): boolean {
  return unstable_isUnrecognizedActionError(error);
}

export function decideStaleServerActionRecovery(
  error: unknown,
  alreadyRecovered: boolean,
): CrashRecovery {
  if (!isStaleServerActionError(error)) return "unrelated";
  // A second one in the same tab means the reload did not put us on the new
  // bundle, so reloading again would only loop.
  return alreadyRecovered ? "already-recovered" : "reload";
}

/** The shared heal, so the catch blocks and the listener spend the same one reload. */
export const STALE_SERVER_ACTION_HEAL: SelfHeal = {
  decide: decideStaleServerActionRecovery,
  storageKey: "haven:stale-server-action-recovered",
  recoveredEvent: "client_stale_server_action_recovered",
  watchRejections: true,
};
