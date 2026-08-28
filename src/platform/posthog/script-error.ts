/**
 * Recognise the browser's opaque cross-origin `window.onerror` report, so a
 * report that carries nothing to act on does not become a ticket someone has to
 * triage.
 *
 * When a script from another origin throws, the browser strips every detail
 * before it reaches `window.onerror` -- no message, no source, no stack -- and
 * hands over a fixed placeholder instead:
 *
 *   "Script error."   (most browsers)
 *   "Script error"    (the bare WebKit variant)
 *
 * posthog-js's `capture_exceptions` picks this up from the global handler and
 * builds a SYNTHETIC exception around the placeholder, because there is no real
 * Error object behind it. The result is an unhandled `$exception` whose value is
 * the placeholder, whose `mechanism` is `synthetic` and unhandled, and whose
 * stack is empty. One occurrence on Firefox iOS at the site root filed an Error
 * Tracking issue with nothing in it.
 *
 * Nothing we ship can produce this. `next.config.ts` proxies every PostHog asset
 * through same-origin `/ingest` rewrites, and `src/app/layout.tsx` loads no
 * third-party script, so an opaque cross-origin error is never one of ours.
 *
 * The match is deliberately narrow. `browser-extension.ts` already drops the
 * stackless "Script error." case when the message names a known extension; this
 * covers the case where the browser left no name at all. All four conditions
 * must hold together -- exact placeholder value, `synthetic`, unhandled, and an
 * empty stack -- so it cannot swallow a real error, which is the bar in
 * `instrumentation-client.ts`.
 */

/**
 * The exact strings browsers use for a redacted cross-origin error. Matched
 * whole, not by prefix: a real error must not slip through by starting with
 * these words.
 */
const OPAQUE_VALUES = new Set(["Script error.", "Script error"]);

/** The slice of a posthog-js `$exception_list` entry this filter reads. */
type ExceptionEntry = {
  value?: unknown;
  mechanism?: { synthetic?: unknown; handled?: unknown };
  stacktrace?: { frames?: unknown };
};

function isOpaqueCrossOriginException(entry: unknown): boolean {
  if (typeof entry !== "object" || entry === null) return false;
  const { value, mechanism, stacktrace } = entry as ExceptionEntry;
  if (typeof value !== "string" || !OPAQUE_VALUES.has(value)) return false;
  if (mechanism?.synthetic !== true || mechanism?.handled !== false) return false;
  const frames = stacktrace?.frames;
  return frames === undefined || (Array.isArray(frames) && frames.length === 0);
}

/** The slice of posthog-js's `CaptureResult` this filter reads. */
type CapturedEvent = {
  event?: string;
  properties?: { $exception_list?: unknown };
};

/**
 * True when a posthog-js event is an `$exception` whose captured errors are ALL
 * opaque cross-origin `window.onerror` reports. Used as a drop condition in
 * `before_send`.
 *
 * An exception that mixes a placeholder with a real error is kept, matching the
 * sibling filters: the real error is the signal.
 */
export function isScriptErrorEvent(event: CapturedEvent | null): boolean {
  if (!event || event.event !== "$exception") return false;
  const list = event.properties?.$exception_list;
  if (!Array.isArray(list) || list.length === 0) return false;
  return list.every(isOpaqueCrossOriginException);
}
