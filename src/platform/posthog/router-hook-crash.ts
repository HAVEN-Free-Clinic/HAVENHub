/**
 * Recognise the React hook-state corruption that kills the App Router root, so
 * the client can reload out of it instead of sitting on a dead page.
 *
 * The crash: React minified error #310, "Rendered more hooks than during the
 * previous render", thrown from Next's own `Router` at the `useMemo` on
 * `next/src/client/components/app-router.tsx:168`. Both of the error-tracking
 * issues we opened for this (fingerprints befab63d... on staging `/` and
 * 39a9bf9b... in production on `/support` then `/my-info`) resolve to that one
 * frame, and neither carries a single application frame -- because the
 * component whose hook list is corrupt is Next's router, not ours.
 *
 * Why it happens (facebook/react#33580, fixed upstream by facebook/react#36911):
 *
 *   1. Something errors during a concurrent render and an error boundary
 *      catches it, so React retries synchronously to recover.
 *   2. During that recovery render, `Router` suspends on `use(thenable)` inside
 *      `useActionQueue` -- the path Next takes when navigating to a route whose
 *      payload has not been prefetched, so router state is a promise blocked on
 *      the server. There is no Suspense boundary above `Router`, so the tree
 *      unwinds to the shell instead of completing.
 *   3. Pre-#36911 React mistook that incomplete tree for a recovered one and
 *      committed it, leaving `Router`'s current fiber holding only the three
 *      hooks it had rendered before suspending (`useState`, `useOptimistic`,
 *      `useMemo`).
 *   4. The next render reaches `Router`'s own fourth hook, finds the committed
 *      hook list exhausted, and throws.
 *
 * That also explains the shape of what we saw: a Microsoft Teams webview, where
 * hover and viewport prefetch largely do not fire, so ordinary navigations take
 * the blocked-on-the-server path in step 2 far more often than they do in a
 * normal browser tab.
 *
 * We cannot fix this from application code. `Router` is above every boundary we
 * own -- including `src/app/global-error.tsx` -- so the throw lands in Next's
 * built-in `DefaultGlobalError` ("Application error: a client-side exception
 * has occurred") and the whole client is dead until someone reloads by hand.
 * The fiber tree is corrupt, so a reload is genuinely the only recovery; this
 * module just makes the client do it for the member.
 *
 * REMOVE THIS once Next ships a React containing facebook/react#36911. Next
 * 16.2.11 and 16.2.12 both vendor `19.3.0-canary-3f0b9e61-20260317`, which
 * predates the fix; `router-hook-crash.test.ts` fails the moment a `next`
 * upgrade brings a React that has it, rather than leaving the workaround here
 * forever.
 */

/**
 * React's minified codes for the two throws in `updateWorkInProgressHook` that
 * fire when the committed hook list runs out mid-render. 310 is the one we have
 * observed ("Rendered more hooks than during the previous render", when the
 * fiber has an alternate); 467 is the same corruption reached with no alternate
 * ("Update hook called on initial render"). Matched by code because production
 * bundles ship the number, not the sentence.
 */
const HOOK_LIST_EXHAUSTED_CODES = [310, 467] as const;

/**
 * The development-build wording for the same two throws, so this also works
 * against `next dev` and against any build that ships unminified React.
 * (`router-hook-crash.test.ts` pins both these and the codes above to the copy
 * of React that Next actually ships, so a renumbering or rewording fails the
 * suite instead of quietly turning the recovery off.)
 */
const HOOK_LIST_EXHAUSTED_MESSAGES = [
  "Rendered more hooks than during the previous render.",
  "Update hook called on initial render.",
] as const;

function isHookListExhaustedText(text: unknown): boolean {
  if (typeof text !== "string") return false;
  return (
    HOOK_LIST_EXHAUSTED_MESSAGES.some((message) => text.includes(message)) ||
    HOOK_LIST_EXHAUSTED_CODES.some((code) =>
      text.includes(`Minified React error #${code};`),
    )
  );
}

/**
 * True when a thrown value is React's hook-list-exhausted error.
 *
 * Accepts a bare string as well as an Error: a global `error` event carries the
 * thrown value on `event.error`, but that is null for a cross-origin script, in
 * which case the browser-prefixed `event.message` is all there is to match on.
 */
export function isHookListExhaustedError(error: unknown): boolean {
  if (typeof error === "string") return isHookListExhaustedText(error);
  if (typeof error !== "object" || error === null) return false;
  return isHookListExhaustedText((error as { message?: unknown }).message);
}

/**
 * What to do about an error that reached the global handler.
 *
 * `already-recovered` exists so a reload can never become a loop: if the same
 * crash greets the member again on the reloaded page, the cause is not the
 * transient race this module is for, and leaving Next's error screen up beats
 * reloading forever.
 */
export type CrashRecovery = "reload" | "already-recovered" | "unrelated";

export function decideCrashRecovery(
  error: unknown,
  alreadyRecovered: boolean,
): CrashRecovery {
  if (!isHookListExhaustedError(error)) return "unrelated";
  return alreadyRecovered ? "already-recovered" : "reload";
}
