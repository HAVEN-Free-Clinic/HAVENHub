/**
 * Recognise the network blip in next-auth's background SESSION POLL so it stays
 * out of Error Tracking.
 *
 * What happens. next-auth's client keeps the session fresh by fetching
 * `/api/auth/session` on an interval, on window focus, and across tabs. That
 * fetch is not wrapped in a catch, so when the network drops for a moment --
 * a laptop waking, a wifi handover, a tunnel, a captive portal -- the browser's
 * `TypeError: Failed to fetch` becomes an UNHANDLED rejection, posthog-js's
 * `capture_exceptions` picks it up, and Error Tracking opens an issue for it.
 *
 * Why nothing is broken. The poll is a refresh, not the session itself: the
 * member's JWT is already in a cookie and is unaffected by a failed poll. The
 * next successful poll -- the following interval, or the next focus event --
 * reconciles. Nobody is signed out, blocked, or shown an error; there is no
 * screen anywhere in the app that changes because one refresh missed.
 *
 * That is the bar this file has to clear, and it is the bar stated in
 * instrumentation-client.ts: "nothing is actually broken", NOT "this message is
 * noisy". A failed request that the member would notice is a real failure and
 * must keep reaching Error Tracking. This one they cannot notice.
 *
 * What we saw. Issue 01a01c06: 2 occurrences from 2 members over 30 days, one on
 * `/my-info` and one on `/schedule/builder`, on different operating systems,
 * each a single resolved frame inside `node_modules/next-auth/react.js` and each
 * `handled: false`. Different pages, different people, one frame, no pattern --
 * a network blip, not a code path.
 *
 * Deliberately narrow, on BOTH axes at once:
 *
 *  - The message must be one the browser produces for a failed fetch. A
 *    `TypeError` from next-auth that says anything else is a real bug of ours
 *    (a misconfigured provider, a bad callback URL) and is kept.
 *  - Every frame must be inside next-auth. `every`, not `some`, matching
 *    browser-extension.ts: our own code calling next-auth and failing must stay
 *    visible, and a frameless event is kept because there is nothing to identify.
 *
 * Neither test alone would be safe. Together they identify one thing: next-auth's
 * own fetch, failing at the network layer.
 *
 * This does NOT cover `TypeError: Failed to fetch` from the posthog session
 * replay recorder, which the team ruled SDK noise separately and suppressed in
 * Error Tracking itself (issues 019f7559, 019f8c3f, GitHub #334). Different
 * frames, different decision, already handled.
 */

/**
 * The path segment browsers report for next-auth's client bundle. Matched as a
 * path fragment so it holds for the Turbopack (`turbopack:///[project]/...`),
 * webpack, and bare-URL spellings alike.
 */
const NEXT_AUTH_PATH = "node_modules/next-auth/";

/**
 * What each engine calls a fetch that never reached the server. Chrome and
 * Edge say "Failed to fetch"; Firefox spells it out; Safari and WebKit use
 * "Load failed" and, on a dropped connection mid-flight, the longer phrase.
 */
const NETWORK_FAILURE_MESSAGES = [
  "Failed to fetch",
  "NetworkError when attempting to fetch resource.",
  "Load failed",
  "The network connection was lost.",
];

function isNextAuthPath(value: unknown): boolean {
  return typeof value === "string" && value.includes(NEXT_AUTH_PATH);
}

function isNetworkFailureMessage(value: unknown): boolean {
  return typeof value === "string" && NETWORK_FAILURE_MESSAGES.includes(value.trim());
}

/** The slice of a posthog-js `$exception_list` entry this filter reads. */
type ExceptionEntry = {
  type?: unknown;
  value?: unknown;
  stacktrace?: { frames?: unknown };
};

function isNextAuthPollFailure(entry: unknown): boolean {
  if (typeof entry !== "object" || entry === null) return false;
  const { type, value, stacktrace } = entry as ExceptionEntry;
  if (type !== "TypeError") return false;
  if (!isNetworkFailureMessage(value)) return false;

  const frames = stacktrace?.frames;
  // No frames means no identification, so there is nothing to be confident
  // about: keep the event. A bare "Failed to fetch" with no stack could have
  // come from anywhere in the app.
  if (!Array.isArray(frames) || frames.length === 0) return false;

  return frames.every((frame) => {
    if (typeof frame !== "object" || frame === null) return false;
    const { filename, source, abs_path } = frame as Record<string, unknown>;
    return isNextAuthPath(filename) || isNextAuthPath(source) || isNextAuthPath(abs_path);
  });
}

/** The slice of posthog-js's `CaptureResult` this filter reads. */
type CapturedEvent = {
  event?: string;
  properties?: { $exception_list?: unknown };
};

/**
 * True when a posthog-js event is an `$exception` whose captured errors are ALL
 * next-auth's session poll failing at the network layer. Used as a drop
 * condition in `before_send`.
 */
export function isAuthSessionPollEvent(event: CapturedEvent | null): boolean {
  if (!event || event.event !== "$exception") return false;
  const list = event.properties?.$exception_list;
  if (!Array.isArray(list) || list.length === 0) return false;
  return list.every(isNextAuthPollFailure);
}
