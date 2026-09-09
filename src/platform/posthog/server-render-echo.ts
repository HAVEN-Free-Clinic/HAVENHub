/**
 * Recognise the client-side *echo* of a server-side render failure, so the same
 * incident is not filed twice -- once usefully and once uselessly.
 *
 * When a Server Component or server action throws in production, two things
 * happen. The server captures the real error through `onRequestError`
 * (`request-error.ts`) with its message, stack, and route. Separately, React's
 * flight client hands the browser a *redacted stand-in* so the failure can be
 * rendered, carrying only a digest and this fixed message:
 *
 *   "An error occurred in the Server Components render. The specific message is
 *    omitted in production builds to avoid leaking sensitive details. A digest
 *    property is included on this error instance which may provide additional
 *    details about the nature of the error."
 *
 * (In the browser that prose is now a minified code instead -- see the two
 * markers below -- but it is the same stand-in.)
 *
 * That stand-in is what our client capture paths see, and it is pure noise:
 * constant message, no stack, no route. Worse, those are exactly the inputs
 * PostHog fingerprints on, so *every* server bug collapses into one issue --
 * issue 019f75b8 had accumulated an unrelated recruitment guard error and a
 * Vercel Blob misconfiguration under a single unactionable heading, each already
 * filed properly server-side within the same second.
 *
 * Dropping the echo costs no coverage: `onRequestError` reports every
 * server-side error, and it bails only on non-node runtimes, of which this app
 * has none (no route sets `runtime = "edge"`). If that ever changes, or server
 * capture is turned off, this filter has to be revisited -- the echo would then
 * be the only signal that anything broke.
 *
 * Used by both client capture paths, alongside the control-flow sentinel filter
 * in `next-control-flow.ts`:
 *
 *   - `instrumentation-client.ts` filters posthog-js's global handler, which
 *     sees the echo as an unhandled error during a soft navigation.
 *   - `capture-exception.tsx` skips echoes that surface in an error boundary.
 */

/**
 * The echo has TWO shapes, because React builds `resolveErrorProd` differently
 * per bundle and Next 16.3 changed which one the browser gets.
 *
 *   client.node.production.js     prose      (SSR: what onRequestError sees)
 *   client.edge.production.js     prose
 *   client.browser.production.js  minified   (soft navigation: what WE see)
 *
 * Up to and including next 16.2.11 the browser bundle carried the prose too, so
 * one marker covered everything. In 16.3.4 the browser build minified it:
 *
 *   function resolveErrorProd() {
 *     var error = Error(formatProdErrorMessage(441));
 *
 * Matching only the prose would therefore have gone quietly dead in the browser
 * on this upgrade -- and the browser is where both of our capture paths run, so
 * every server bug would have collapsed back into one unactionable PostHog
 * issue. Both markers are pinned to the shipped bundles by
 * `server-render-echo.test.ts`, which is what caught the change.
 */

/**
 * The redaction sentence, still emitted by the node and edge clients. Matched
 * instead of the full message because React owns the surrounding wording: this
 * clause is the part that actually means "the real message was withheld and
 * reported elsewhere". It is React-internal prose, so an app error will not
 * carry it by accident.
 */
const REDACTION_MARKER =
  "The specific message is omitted in production builds to avoid leaking sensitive details.";

/**
 * The browser client's minified stand-in. Pinned to the ONE code React uses for
 * this error, not to "any minified React error": the generic prefix would drop
 * real client-side React failures, which is the opposite of the point. A React
 * upgrade that renumbers this fails the test rather than silently widening or
 * narrowing the filter.
 */
const MINIFIED_ECHO_MARKER = "Minified React error #441;";

function isEchoText(text: unknown): boolean {
  return (
    typeof text === "string" &&
    (text.includes(REDACTION_MARKER) || text.includes(MINIFIED_ECHO_MARKER))
  );
}

/**
 * True when a thrown value is React's redacted stand-in for a server-side
 * error. Used by the error boundaries, which get the error object itself.
 */
export function isServerRenderEchoError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  return isEchoText((error as { message?: unknown }).message);
}

/** The slice of posthog-js's `CaptureResult` this filter reads. */
type CapturedEvent = {
  event?: string;
  properties?: { $exception_list?: unknown };
};

/**
 * True when a posthog-js event is an `$exception` whose captured errors are all
 * redacted server-render echoes. Used as a drop condition in `before_send`,
 * which sees only the serialised event, where the message arrives as the
 * exception `value`.
 *
 * An exception that mixes an echo with a real error is kept -- the real error is
 * the signal.
 */
export function isServerRenderEchoEvent(event: CapturedEvent | null): boolean {
  if (!event || event.event !== "$exception") return false;
  const list = event.properties?.$exception_list;
  if (!Array.isArray(list) || list.length === 0) return false;
  return list.every(
    (entry) =>
      typeof entry === "object" &&
      entry !== null &&
      isEchoText((entry as { value?: unknown }).value),
  );
}
