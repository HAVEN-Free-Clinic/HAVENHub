/**
 * Recognise the chunk-load failure that leaves a member on a dead page, so the
 * client can reload once and fetch the chunk again instead of sitting there.
 *
 * The crash: Turbopack's browser runtime cannot fetch a JavaScript chunk and
 * throws `Failed to load chunk <url> from module <id>`, a plain Error with no
 * retry. We saw it five times in 2.5 seconds on `/login` from one Mobile Safari
 * session (issue #677). The build had been live about 25 hours, so the chunk
 * existed and the request itself dropped -- the shape of a transient mobile
 * network drop, not a stale tab racing a deploy. Nothing above the throw catches
 * this class, so the member is stranded on `/login`, the way into the whole Hub,
 * until they reload by hand. A reload re-requests the chunk, which is the only
 * recovery for a dropped request.
 *
 * Two bundlers, two shapes, so this matches both:
 *   - Turbopack (our production bundler): a plain Error whose message is
 *     `Failed to load chunk ...`. `name` is `Error`, so we match on the message.
 *   - webpack (the fallback bundler): an Error whose `name` is `ChunkLoadError`
 *     and whose message is `Loading chunk <id> failed`.
 *
 * This failure stays in Error Tracking; it is NOT added to the `before_send`
 * drop chain in instrumentation-client.ts. A dropped chunk IS a real
 * user-facing failure, and that chain is for "nothing is actually broken", not
 * for "we handled it". The self-heal instead files its own
 * `client_chunk_load_recovered` event, which is what tells us it earns its keep
 * -- exactly as the router-hook-crash recovery does (see router-hook-crash.ts).
 */

import type { CrashRecovery } from "./router-hook-crash";

/** The `name` webpack gives a chunk-load error. Turbopack leaves `name` as `Error`. */
const CHUNK_LOAD_ERROR_NAME = "ChunkLoadError";

/**
 * The distinctive text each bundler puts in the message. Turbopack throws
 * `Failed to load chunk ...`; webpack throws `Loading chunk <id> failed`. Matched
 * by message because a cross-origin `error` event delivers only the message
 * string, and because Turbopack's plain Error carries no telltale `name`.
 */
const CHUNK_LOAD_MESSAGES = ["Failed to load chunk", "Loading chunk"] as const;

function isChunkLoadText(text: unknown): boolean {
  if (typeof text !== "string") return false;
  return CHUNK_LOAD_MESSAGES.some((message) => text.includes(message));
}

/**
 * True when a thrown value is a chunk-load failure.
 *
 * Accepts a bare string as well as an Error: a global `error` event carries the
 * thrown value on `event.error`, but that is null for a cross-origin script, in
 * which case the browser-prefixed `event.message` is all there is to match on.
 */
export function isChunkLoadError(error: unknown): boolean {
  if (typeof error === "string") return isChunkLoadText(error);
  if (typeof error !== "object" || error === null) return false;
  const { name, message } = error as { name?: unknown; message?: unknown };
  return name === CHUNK_LOAD_ERROR_NAME || isChunkLoadText(message);
}

export function decideChunkLoadRecovery(
  error: unknown,
  alreadyRecovered: boolean,
): CrashRecovery {
  if (!isChunkLoadError(error)) return "unrelated";
  return alreadyRecovered ? "already-recovered" : "reload";
}
