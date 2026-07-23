/**
 * Recognise Next.js control-flow sentinels so they stay out of Error Tracking.
 *
 * `redirect()`, `notFound()`, `forbidden()` and `unauthorized()` are implemented
 * by *throwing* rather than returning. The thrown Error carries a well-known
 * code as both its message and its `digest`:
 *
 *   redirect("/no-access")  ->  "NEXT_REDIRECT;replace;/no-access;307;"
 *   notFound()              ->  "NEXT_HTTP_ERROR_FALLBACK;404"
 *
 * Next unwinds on that code to perform the navigation, so these are intended
 * control flow, not crashes, and reporting them buries real errors in noise.
 * (`next-control-flow.test.ts` pins the codes to what Next actually throws, so
 * a framework rename fails the suite instead of silently un-filtering.)
 *
 * The server path is already clean -- Next resolves these sentinels itself and
 * never hands them to `onRequestError` (see `request-error.ts`). The two client
 * paths are not, so both use the helpers here:
 *
 *   - `instrumentation-client.ts` filters posthog-js's global handler, which
 *     picks the sentinel up as an unhandled rejection during a soft navigation.
 *   - `capture-exception.tsx` skips sentinels that surface in an error boundary.
 */

/**
 * Error codes Next.js prefixes its control-flow sentinels with.
 * `NEXT_HTTP_ERROR_FALLBACK` covers `notFound()` (404), `unauthorized()` (401),
 * and `forbidden()` (403), which all share the code and differ by suffix.
 */
const SENTINEL_CODES = ["NEXT_REDIRECT", "NEXT_HTTP_ERROR_FALLBACK"] as const;

function isSentinelText(text: unknown): boolean {
  return (
    typeof text === "string" &&
    SENTINEL_CODES.some((code) => text.startsWith(code))
  );
}

/**
 * True when a thrown value is a Next.js control-flow sentinel. Used by the error
 * boundaries, which get the error object itself. Checks `digest` as well as the
 * message because Next scrubs server-component error messages in production
 * while leaving the digest intact.
 */
export function isNextControlFlowError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const { digest, message } = error as { digest?: unknown; message?: unknown };
  return isSentinelText(digest) || isSentinelText(message);
}

/** The slice of posthog-js's `CaptureResult` this filter reads. */
type CapturedEvent = {
  event?: string;
  properties?: { $exception_list?: unknown };
};

/**
 * True when a posthog-js event is an `$exception` whose captured errors are all
 * Next.js control-flow sentinels. Used as the drop condition in `before_send`,
 * which sees only the serialised event: the sentinel arrives as the exception
 * `value` (the message), since the `digest` is not carried onto the event.
 *
 * An exception that mixes a sentinel with a real error is kept -- the real error
 * is the signal.
 */
export function isNextControlFlowEvent(event: CapturedEvent | null): boolean {
  if (!event || event.event !== "$exception") return false;
  const list = event.properties?.$exception_list;
  if (!Array.isArray(list) || list.length === 0) return false;
  return list.every(
    (entry) =>
      typeof entry === "object" &&
      entry !== null &&
      isSentinelText((entry as { value?: unknown }).value),
  );
}
