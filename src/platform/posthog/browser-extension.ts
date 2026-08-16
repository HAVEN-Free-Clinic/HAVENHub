/**
 * Recognise exceptions thrown by the visitor's BROWSER EXTENSIONS so they stay
 * out of Error Tracking.
 *
 * posthog-js's `capture_exceptions` listens on `window.onerror` and
 * `unhandledrejection`, which fire for anything running in the page -- including
 * content scripts injected by whatever extensions the visitor happens to have
 * installed. Those exceptions are attributed to our site because they happened
 * on our page, but no deploy of ours can cause or fix them.
 *
 * This is not hypothetical: a visitor with the Zotero Connector installed
 * produced "Zotero Connector: Failed to send message i18n.getStrings to
 * background page. It may be dead." -- an extension talking to its own dead
 * background worker -- which became an Error Tracking issue and then an
 * auto-filed GitHub issue that sat in the open list alongside real defects.
 *
 * Two independent signals, because either can be missing:
 *
 *  - A stack frame whose filename is an extension URL. This is the reliable one
 *    when a stack survives, and it is scheme-based rather than a list of
 *    extension names, so it needs no maintenance as visitors install things.
 *  - A message naming a known extension. Needed because a cross-origin script
 *    error is delivered to `window.onerror` with the stack stripped ("Script
 *    error."), leaving the message as the only evidence.
 *
 * Deliberately NOT a general "does the message look third-party" heuristic: a
 * broad matcher here would silently eat our own errors, which is a far worse
 * failure than filing the occasional extension issue. Both predicates require a
 * positive identification.
 */

/**
 * URL schemes browsers serve extension code from. Chrome/Edge/Brave use
 * `chrome-extension:`, Firefox `moz-extension:`, Safari `safari-web-extension:`
 * (and `safari-extension:` for the legacy kind).
 */
const EXTENSION_SCHEMES = [
  "chrome-extension://",
  "moz-extension://",
  "safari-web-extension://",
  "safari-extension://",
  "ms-browser-extension://",
];

/**
 * Message prefixes belonging to specific extensions, for the stackless case.
 *
 * Add to this only with a real captured message in hand. Every entry names one
 * product, so a match cannot be one of ours by accident.
 */
const EXTENSION_MESSAGE_MARKERS = ["Zotero Connector:", "Grammarly:"];

function isExtensionUrl(value: unknown): boolean {
  return (
    typeof value === "string" &&
    EXTENSION_SCHEMES.some((scheme) => value.includes(scheme))
  );
}

function hasExtensionMarker(value: unknown): boolean {
  return (
    typeof value === "string" &&
    EXTENSION_MESSAGE_MARKERS.some((marker) => value.includes(marker))
  );
}

/** The slice of a posthog-js `$exception_list` entry this filter reads. */
type ExceptionEntry = {
  value?: unknown;
  stacktrace?: { frames?: unknown };
};

function isExtensionException(entry: unknown): boolean {
  if (typeof entry !== "object" || entry === null) return false;
  const { value, stacktrace } = entry as ExceptionEntry;
  if (hasExtensionMarker(value)) return true;

  const frames = stacktrace?.frames;
  if (!Array.isArray(frames) || frames.length === 0) return false;
  // `every`, deliberately, not `some`. An extension frame ANYWHERE in the stack
  // is not enough: extensions monkey-patch fetch and XHR, so a genuine bug of
  // ours can easily carry one, and dropping on that would silently delete real
  // errors. Requiring the WHOLE stack to be extension code cannot do that -- if
  // one of our files appears, the event is kept. It still catches the case worth
  // catching, a content script throwing entirely inside itself.
  //
  // A frame with no recognisable filename fails the test and keeps the event,
  // which is the safe direction.
  return frames.every((frame) => {
    if (typeof frame !== "object" || frame === null) return false;
    const { filename, source, abs_path } = frame as Record<string, unknown>;
    return isExtensionUrl(filename) || isExtensionUrl(source) || isExtensionUrl(abs_path);
  });
}

/** The slice of posthog-js's `CaptureResult` this filter reads. */
type CapturedEvent = {
  event?: string;
  properties?: { $exception_list?: unknown };
};

/**
 * True when a posthog-js event is an `$exception` whose captured errors ALL come
 * from a browser extension. Used as a drop condition in `before_send`.
 *
 * `every`, matching the Next control-flow filter: an exception that mixes
 * extension code with a real error of ours is kept, because the real error is
 * the signal.
 */
export function isBrowserExtensionEvent(event: CapturedEvent | null): boolean {
  if (!event || event.event !== "$exception") return false;
  const list = event.properties?.$exception_list;
  if (!Array.isArray(list) || list.length === 0) return false;
  return list.every(isExtensionException);
}
