/**
 * Recognise a NON-ERROR value that reached the global exception handler and left
 * nothing to act on, so it stays out of Error Tracking.
 *
 * When something that is not an `Error` reaches `window.onerror` or fires
 * `unhandledrejection` -- a thrown plain object, a dispatched event, a bare
 * string -- there is no real Error behind it. posthog-js's `capture_exceptions`
 * cannot read a stack off a value that has none, so it COERCES the value into a
 * synthetic placeholder: it sets `mechanism.synthetic` to true and builds a
 * `value` of the form "<Thing> captured as exception ...". A real `Error` (or
 * `DOMException`) is never coerced this way; its `mechanism.synthetic` stays
 * false.
 *
 * Nothing we ship throws a non-Error value: our code throws `Error` subclasses
 * and rejects with them. So a synthetic, unhandled placeholder that also carries
 * no first-party frame is not ours -- it is the visitor's browser, or a script
 * that browser injected, throwing inside our page, which lands on us only because
 * it happened here and which no deploy of ours can fix. Safari does exactly this
 * and masks the injected script's URL as `webkit-masked-url://hidden/`, so the
 * one placeholder that keeps a stack has only that frame.
 *
 * Not hypothetical. One Safari 27 visit to an `/onboard/<token>` page produced
 * three of these in two seconds -- a `CustomEvent` whose only key is `isTrusted`,
 * an empty object, and a `TimeoutError` object -- and each opened its own Error
 * Tracking issue, which the GitHub integration then filed as a ticket beside real
 * defects.
 *
 * Three conditions must hold together, so this cannot swallow a real error:
 *
 *  - `mechanism.synthetic` is true. This is the load-bearing test: only a
 *    non-Error value is coerced, so a genuine `Error`/`DOMException` of ours is
 *    already excluded here.
 *  - `mechanism.handled` is false. A non-Error value we captured on purpose with
 *    `captureException` is kept.
 *  - The value is one of posthog-js's coercion placeholders AND no frame is
 *    first-party. A placeholder that points at one of our files is actionable and
 *    stays. A PRIMITIVE promise rejection reads "Non-Error promise rejection
 *    captured with value: ...", which does not carry the marker, so it stays too.
 *    An OBJECT rejection does not get that wording: posthog-js hands its reason
 *    to the same object coercer, so it carries the marker and is judged on its
 *    frames like any other placeholder. That is acceptable only because nothing
 *    we ship rejects with a plain object; keep it that way.
 *
 * This is the bar in instrumentation-client.ts: "nothing is actually broken", NOT
 * "this message is noisy". A placeholder that is the only evidence of a real
 * failure keeps its frame and is kept.
 */

/**
 * The phrase posthog-js writes into `value` when it coerces a thrown non-Error.
 * Every coercion of an object, event, or primitive contains it: "CustomEvent
 * captured as exception with keys: isTrusted", "Object captured as exception with
 * keys: [object has no keys]", "'TimeoutError' captured as exception with
 * message: 'operation timed out'", "Primitive value captured as exception: ...".
 */
const COERCION_MARKER = "captured as exception";

/**
 * Safari's stand-in for a script it injected into the page. It replaces the real
 * URL in the stack frame, so a frame that carries it is injected browser code,
 * never one of ours.
 */
const MASKED_URL_SCHEME = "webkit-masked-url:";

function hasCoercionMarker(value: unknown): boolean {
  return typeof value === "string" && value.includes(COERCION_MARKER);
}

function isMaskedUrl(value: unknown): boolean {
  return typeof value === "string" && value.includes(MASKED_URL_SCHEME);
}

/** The slice of a posthog-js `$exception_list` entry this filter reads. */
type ExceptionEntry = {
  value?: unknown;
  mechanism?: { synthetic?: unknown; handled?: unknown };
  stacktrace?: { frames?: unknown };
};

function isMaskedFrame(frame: unknown): boolean {
  if (typeof frame !== "object" || frame === null) return false;
  const { filename, source, abs_path } = frame as Record<string, unknown>;
  return isMaskedUrl(filename) || isMaskedUrl(source) || isMaskedUrl(abs_path);
}

function hasNoFirstPartyFrame(frames: unknown): boolean {
  // No stack at all -- the CustomEvent and empty-object placeholders arrive this
  // way -- means there is no frame to act on. A malformed non-array is kept.
  if (!Array.isArray(frames)) return frames === undefined;
  if (frames.length === 0) return true;
  // A stack that is ENTIRELY Safari-masked frames is injected code. `every`, not
  // `some`, matching the sibling filters: one first-party frame is actionable
  // evidence and keeps the event.
  return frames.every(isMaskedFrame);
}

function isCoercedNonError(entry: unknown): boolean {
  if (typeof entry !== "object" || entry === null) return false;
  const { value, mechanism, stacktrace } = entry as ExceptionEntry;
  if (mechanism?.synthetic !== true || mechanism?.handled !== false) return false;
  if (!hasCoercionMarker(value)) return false;
  return hasNoFirstPartyFrame(stacktrace?.frames);
}

/** The slice of posthog-js's `CaptureResult` this filter reads. */
type CapturedEvent = {
  event?: string;
  properties?: { $exception_list?: unknown };
};

/**
 * True when a posthog-js event is an `$exception` whose captured errors are ALL
 * synthetic placeholders for a non-Error value with nothing first-party to act
 * on. Used as a drop condition in `before_send`.
 *
 * An exception that mixes a placeholder with a real error is kept, matching the
 * sibling filters: the real error is the signal.
 */
export function isNonErrorThrowEvent(event: CapturedEvent | null): boolean {
  if (!event || event.event !== "$exception") return false;
  const list = event.properties?.$exception_list;
  if (!Array.isArray(list) || list.length === 0) return false;
  return list.every(isCoercedNonError);
}
