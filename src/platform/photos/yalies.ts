/**
 * Yalies API client, narrowed to one job: netId to photo bytes.
 *
 * Yalies (https://yalies.io) is a Yale Computer Society project that scrapes the
 * Yale Face Book and Directory. It publishes no rate limit, uptime commitment,
 * or terms of use, so this client treats it as unreliable by default: one
 * attempt, a hard timeout, and null on every failure. Retry policy lives in
 * service.ts, which has the state to back it off.
 *
 * Photos exist for Yale College students only. The Face Book scrape is the sole
 * source of the `image` field, so anyone sourced from the Directory instead
 * (medicine, nursing, public health, graduate, staff) always returns null here.
 *
 * This is the only module talking to a third party, and there is no API key in
 * this environment, so the live response shape has never actually been
 * exercised: photoUrlFrom's assumptions (a bare JSON array, `[0].image` on
 * exactly PHOTO_HOST) are unverified against the real API. Every miss branch
 * below logs a short reason so a shape change, a revoked key, or a rate limit
 * shows up as a pattern in the logs instead of a silent, permanent stream of
 * misses. Never log the API key, the Authorization header, or the netId (no
 * other module in this codebase logs a netId; keep it that way here too).
 */
import { config } from "@/platform/config";
import { log, errorAttrs } from "@/platform/logging";

const API_URL = "https://api.yalies.io/v2/people";

/**
 * Yalies re-hosts scraped Face Book photos in one S3 bucket. Pinning the host
 * means a compromised or buggy API response cannot point our server-side fetch
 * at an arbitrary address, including cloud metadata endpoints. Both fetches
 * also disable automatic redirect following, since a followed redirect would
 * land on an unpinned host that is never checked against PHOTO_HOST.
 */
const PHOTO_HOST = "yalestudentphotos.s3.amazonaws.com";

/**
 * One attempt gets 2 seconds total, spanning both the person lookup and the
 * image download as a single deadline. A slow Yalies must never become a
 * slow page.
 */
export const YALIES_TIMEOUT_MS = 2000;

/** True when an API key is configured. Without one, auto-sourcing is inert. */
export function isYaliesEnabled(): boolean {
  return Boolean(config.YALIES_API_KEY);
}

/** Why photoUrlFrom could not produce a usable URL, for the miss log below. */
type PhotoUrlMiss = "no_match" | "no_image" | "bad_host";

/** The photo URL if this response body carries a usable one, else why not. */
function photoUrlFrom(body: unknown): { url: string } | { miss: PhotoUrlMiss } {
  if (!Array.isArray(body) || body.length === 0) return { miss: "no_match" };
  const image = (body[0] as { image?: unknown }).image;
  if (typeof image !== "string" || image === "") return { miss: "no_image" };

  let parsed: URL;
  try {
    parsed = new URL(image);
  } catch {
    return { miss: "bad_host" };
  }
  if (parsed.protocol !== "https:" || parsed.hostname !== PHOTO_HOST) return { miss: "bad_host" };
  return { url: parsed.toString() };
}

/** One line per miss, with a short discriminator instead of the full context. */
function logMiss(reason: string, extra?: Record<string, string | number | boolean>): void {
  log.warn("[yalies] photo miss", { reason, ...extra });
}

/**
 * Photo bytes for a netId, or null when there is no photo to be had.
 *
 * Null covers every failure: no API key, no match, no image on the record, a
 * non-2xx from either hop, an unexpected host, a redirect, a non-image body, an
 * oversized image, a timeout, and an unreachable host. Callers cannot
 * distinguish them and should not try -- but every one of these branches logs a
 * reason (see logMiss above), so an operator can.
 *
 * `maxBytes` bounds the image download the same way uploads.maxMb bounds a
 * member's own upload (see service.ts, which passes it in): this module has no
 * settings dependency of its own on purpose, so the caller resolves the limit
 * and passes it through rather than this file hardcoding or importing one.
 */
export async function fetchYaliesPhoto(netId: string, maxBytes: number): Promise<Buffer | null> {
  if (!config.YALIES_API_KEY) {
    logMiss("no_api_key");
    return null;
  }

  // One deadline for the whole operation, not one per hop: two independent
  // 2-second timeouts would let a slow Yalies cost up to 4 seconds, breaking
  // the promise on YALIES_TIMEOUT_MS above.
  const signal = AbortSignal.timeout(YALIES_TIMEOUT_MS);

  try {
    const lookup = await fetch(API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.YALIES_API_KEY}`,
      },
      body: JSON.stringify({ filters: { netid: [netId] } }),
      signal,
      redirect: "manual",
    });
    if (!lookup.ok) {
      logMiss("lookup_not_ok", { status: lookup.status });
      return null;
    }

    const result = photoUrlFrom(await lookup.json());
    if ("miss" in result) {
      logMiss(result.miss);
      return null;
    }

    // redirect: "manual" keeps a followed redirect from ever landing on a
    // host we have not pinned: a manual-mode redirect response comes back
    // with an opaque, non-ok status instead of being followed transparently.
    const image = await fetch(result.url, { signal, redirect: "manual" });
    if (!image.ok) {
      logMiss("image_not_ok", { status: image.status });
      return null;
    }
    if (!(image.headers.get("content-type") ?? "").startsWith("image/")) {
      logMiss("not_an_image");
      return null;
    }

    // Bound the download the same way the upload path bounds a member's own
    // file, before spending memory buffering it. content-length is
    // caller-declared (like the upload form's file.size), so the buffer's
    // actual length is checked again below regardless of whether this header
    // was present or honest.
    const declaredLength = Number(image.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      logMiss("too_large", { bytes: declaredLength });
      return null;
    }

    const bytes = Buffer.from(await image.arrayBuffer());
    if (bytes.length > maxBytes) {
      logMiss("too_large", { bytes: bytes.length });
      return null;
    }

    log.info("[yalies] photo fetched", { bytes: bytes.length });
    return bytes;
  } catch (err) {
    // Timeout, DNS failure, connection reset, malformed JSON. All are misses.
    log.warn("[yalies] photo miss", errorAttrs(err, { reason: "exception" }));
    return null;
  }
}
