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
 * Where Yalies is allowed to serve a photo from.
 *
 * The `image` URL is third-party input that we fetch server-side, so it is
 * checked against this list rather than trusted. Without that, a compromised or
 * buggy response could point our server at an arbitrary address, including the
 * cloud metadata endpoint. Both fetches also disable automatic redirect
 * following, since a followed redirect would land on a host never checked here.
 *
 * A path prefix accompanies each host because the check is only as tight as its
 * narrowest part. `storage.googleapis.com` is shared by every Google Cloud
 * Storage bucket on the internet, so pinning the hostname alone would accept any
 * of them; pinning the bucket path restores the specificity the old dedicated S3
 * subdomain had for free.
 *
 * This is a list, not a constant, because it has already drifted once: Yalies
 * migrated from S3 to Google Cloud Storage without updating the scraper source
 * this was originally read from, and every Yale College member silently missed
 * until the log named the new host. The S3 entry is retained so a partial or
 * reverted migration does not break sourcing again.
 */
const PHOTO_SOURCES: ReadonlyArray<{ host: string; prefix: string }> = [
  { host: "storage.googleapis.com", prefix: "/yalies-photos/" },
  { host: "yalestudentphotos.s3.amazonaws.com", prefix: "/" },
];

/** True when a parsed https URL points at an allowed bucket path. */
function isAllowedPhotoUrl(parsed: URL): boolean {
  return PHOTO_SOURCES.some(
    (source) => parsed.hostname === source.host && parsed.pathname.startsWith(source.prefix)
  );
}

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
type PhotoUrlMiss =
  | "no_match"
  | "no_image"
  | "unparseable_url"
  | "bad_protocol"
  | "bad_host";

/** A miss, plus whatever detail makes the next occurrence self-diagnosing. */
type PhotoUrlResult = { url: string } | { miss: PhotoUrlMiss; detail?: Record<string, string> };

/**
 * The photo URL if this response body carries a usable one, else why not.
 *
 * The rejection reasons are deliberately split rather than collapsed into one
 * "bad url". A drifted image host is the likeliest cause of a sudden total miss
 * stream (it is the one part of the response contract we pin to a literal), and
 * a log that says only "bad_host" leaves the reader with no way to learn the new
 * value short of querying the API by hand. So the offending host travels with
 * the miss.
 *
 * The HOSTNAME is safe to log; the full URL is not. Its path carries a
 * per-person filename, which is exactly the sort of identifier that should not
 * be sprayed into logs to diagnose a configuration problem.
 */
function photoUrlFrom(body: unknown): PhotoUrlResult {
  if (!Array.isArray(body) || body.length === 0) return { miss: "no_match" };
  const image = (body[0] as { image?: unknown }).image;
  if (typeof image !== "string" || image === "") return { miss: "no_image" };

  let parsed: URL;
  try {
    parsed = new URL(image);
  } catch {
    return { miss: "unparseable_url" };
  }
  if (parsed.protocol !== "https:") {
    return { miss: "bad_protocol", detail: { protocol: parsed.protocol, host: parsed.hostname } };
  }
  if (!isAllowedPhotoUrl(parsed)) {
    // Host and bucket segment travel with the miss, so a future migration is one
    // log line to diagnose rather than a manual query against the API. The
    // filename is deliberately dropped: it is per-person, and the bucket is the
    // only part needed to update PHOTO_SOURCES.
    const bucket = `/${parsed.pathname.split("/")[1] ?? ""}/`;
    return { miss: "bad_host", detail: { host: parsed.hostname, bucket } };
  }
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
      logMiss(result.miss, result.detail);
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
