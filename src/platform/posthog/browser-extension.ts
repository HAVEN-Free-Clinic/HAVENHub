/**
 * Recognise exceptions that no deploy of ours can cause or fix, so they stay out
 * of Error Tracking. Two sources, both of which run inside our page and are
 * therefore attributed to our site:
 *
 *  - the visitor's BROWSER EXTENSIONS, through their content scripts, and
 *  - the BROWSER ITSELF, through the scripts it injects into every page it
 *    renders.
 *
 * posthog-js's `capture_exceptions` listens on `window.onerror` and
 * `unhandledrejection`, which fire for anything running in the page, including
 * both of those.
 *
 * Neither is hypothetical. A visitor with the Zotero Connector installed
 * produced "Zotero Connector: Failed to send message i18n.getStrings to
 * background page. It may be dead.", an extension talking to its own dead
 * background worker. A visitor on Firefox for iOS produced "Can't find variable:
 * __firefox__" and "undefined is not an object (evaluating
 * 'window.__firefox__.reader')", that browser's own injected reader-mode script
 * racing the namespace it expects to find. Both became Error Tracking issues and
 * then auto-filed GitHub issues that sat in the open list alongside real
 * defects.
 *
 * Three independent signals, because any of them can be missing:
 *
 *  - A stack frame whose filename is an extension URL. This is the reliable one
 *    when a stack survives, and it is scheme-based rather than a list of
 *    extension names, so it needs no maintenance as visitors install things.
 *  - A message naming a known extension. Needed because a cross-origin script
 *    error is delivered to `window.onerror` with the stack stripped ("Script
 *    error."), leaving the message as the only evidence.
 *  - A message naming a global that only a browser or an extension injects.
 *    Needed because a script injected INLINE into the document gets a stack
 *    whose single frame IS the document ("global code", line 1, our own URL),
 *    which no filename test can tell apart from our code. The global it names is
 *    then the only evidence left.
 *
 * Deliberately NOT a general "does the message look third-party" heuristic: a
 * broad matcher here would silently eat our own errors, which is a far worse
 * failure than filing the occasional extension issue. All three predicates
 * require a positive identification.
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

/**
 * Globals that ONLY a browser or an extension puts on `window`, for the case
 * where the injected script ran inline and its stack therefore points at our own
 * document rather than at any extension URL.
 *
 * Add to this only with a real captured message in hand, and only for a token
 * that cannot turn up in a message of ours. Both entries below were checked
 * against the source tree: neither name is defined, read, or so much as
 * mentioned anywhere in it, so a match here cannot be one of our errors.
 *
 *  - `__firefox__` is the namespace Firefox for iOS injects into every page it
 *    renders, for reader mode and its other browser features. Captured on /login
 *    from Firefox for iOS 18.7 in both of its shapes, "Can't find variable:
 *    __firefox__" and "undefined is not an object (evaluating
 *    'window.__firefox__.reader')".
 *  - `window.ethereum` is the EIP-1193 provider that crypto wallet extensions
 *    inject. Captured in that same session as "undefined is not an object
 *    (evaluating 'window.ethereum.selectedAddress = undefined')". Qualified with
 *    `window.` deliberately: bare "ethereum" is an ordinary English word that
 *    could legitimately appear in a message of ours, and it is the property
 *    access, not the word, that identifies the injection.
 */
const INJECTED_GLOBAL_MARKERS = ["__firefox__", "window.ethereum"];

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

function namesInjectedGlobal(value: unknown): boolean {
  return (
    typeof value === "string" &&
    INJECTED_GLOBAL_MARKERS.some((marker) => value.includes(marker))
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
  if (namesInjectedGlobal(value)) return true;

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
 * from a browser extension or from a script the browser injected. Used as a drop
 * condition in `before_send`.
 *
 * `every`, matching the Next control-flow filter: an exception that mixes
 * injected code with a real error of ours is kept, because the real error is the
 * signal.
 */
export function isBrowserExtensionEvent(event: CapturedEvent | null): boolean {
  if (!event || event.event !== "$exception") return false;
  const list = event.properties?.$exception_list;
  if (!Array.isArray(list) || list.length === 0) return false;
  return list.every(isExtensionException);
}
