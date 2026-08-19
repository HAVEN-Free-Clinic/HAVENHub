/**
 * Recognise React's *recoverable* hydration mismatches, so a blip nobody saw
 * does not become a ticket somebody has to triage.
 *
 * When server-rendered HTML does not match what the client would have rendered,
 * React reports the mismatch and then re-renders on the client. The visitor ends
 * up looking at correct UI; nothing is broken by the time they notice anything.
 * The event still reaches the global exception handler, and in production React
 * has minified it to a bare:
 *
 *   "Minified React error #418; visit https://react.dev/errors/418?args[]=HTML
 *    for the full message..."
 *
 * `args[]=HTML` is the whole payload -- no element name, no component frame, no
 * route beyond the URL. There is nothing in it to act on, and one occurrence on
 * one page filed both a Linear issue and a GitHub issue five seconds apart, each
 * titled just "Error".
 *
 * Only the codes where React RECOVERS BY ITSELF are dropped, and deliberately
 * not the neighbouring ones:
 *
 *   #418  server HTML did not match the client; React re-renders. Recoverable.
 *   #425  text content did not match; same. Recoverable.
 *
 *   #421/#422/#423 are NOT here. Those mean an error was *thrown* while
 *   hydrating, and React switched to client rendering because of it. The thrown
 *   error is a real failure that gets reported on its own, so filtering that
 *   family would hide a genuine bug rather than a cosmetic mismatch.
 *
 * This is the same judgement `server-render-echo.ts` makes: drop the event that
 * carries no information, keep the one that does. The opposite call was made for
 * the /my-info upload failures, where an equally noisy exception was the ONLY
 * evidence of a user-facing dead end -- filtering is right only when nothing is
 * actually broken.
 *
 * Wired into `instrumentation-client.ts` only. The error-boundary path
 * (`capture-exception.tsx`) does not need it: a recoverable mismatch never trips
 * a boundary, precisely because React handles it.
 */

/**
 * React error codes for a hydration mismatch React recovers from unaided.
 * (`react-hydration.test.ts` pins these against the copy of React that Next
 * ships, so a renumbering fails the suite instead of silently un-filtering.)
 */
const RECOVERABLE_HYDRATION_CODES = new Set([418, 425]);

/**
 * The React error number in a minified production message, or null.
 *
 * Matches the number rather than the prose because the prose is a URL and a
 * truncation notice that React rewords freely, while the code is the stable
 * identifier it asks you to look up.
 */
function reactErrorCode(text: unknown): number | null {
  if (typeof text !== "string") return null;
  const minified = /Minified React error #(\d+)/.exec(text);
  if (minified) return Number(minified[1]);
  // Development (and any build with the un-minified error map) spells the same
  // failure out in prose but still links the numbered page.
  const linked = /react\.dev\/errors\/(\d+)/.exec(text);
  return linked ? Number(linked[1]) : null;
}

function isRecoverableHydrationText(text: unknown): boolean {
  const code = reactErrorCode(text);
  return code !== null && RECOVERABLE_HYDRATION_CODES.has(code);
}

/** The slice of posthog-js's `CaptureResult` this filter reads. */
type CapturedEvent = {
  event?: string;
  properties?: { $exception_list?: unknown };
};

/**
 * True when a posthog-js event is an `$exception` whose captured errors are ALL
 * recoverable hydration mismatches. Used as a drop condition in `before_send`.
 *
 * An exception mixing a mismatch with a real error is kept, matching the sibling
 * filters: the real error is the signal.
 */
export function isRecoverableHydrationEvent(event: CapturedEvent | null): boolean {
  if (!event || event.event !== "$exception") return false;
  const list = event.properties?.$exception_list;
  if (!Array.isArray(list) || list.length === 0) return false;
  return list.every(
    (entry) =>
      typeof entry === "object" &&
      entry !== null &&
      isRecoverableHydrationText((entry as { value?: unknown }).value),
  );
}
