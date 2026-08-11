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
 */
import { config } from "@/platform/config";

const API_URL = "https://api.yalies.io/v2/people";

/**
 * Yalies re-hosts scraped Face Book photos in one S3 bucket. Pinning the host
 * means a compromised or buggy API response cannot point our server-side fetch
 * at an arbitrary address, including cloud metadata endpoints.
 */
const PHOTO_HOST = "yalestudentphotos.s3.amazonaws.com";

/** One attempt gets 2 seconds. A slow Yalies must never become a slow page. */
export const YALIES_TIMEOUT_MS = 2000;

/** True when an API key is configured. Without one, auto-sourcing is inert. */
export function isYaliesEnabled(): boolean {
  return Boolean(config.YALIES_API_KEY);
}

/** The photo URL if this response body carries a usable one, else null. */
function photoUrlFrom(body: unknown): string | null {
  if (!Array.isArray(body) || body.length === 0) return null;
  const image = (body[0] as { image?: unknown }).image;
  if (typeof image !== "string" || image === "") return null;

  let parsed: URL;
  try {
    parsed = new URL(image);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" || parsed.hostname !== PHOTO_HOST) return null;
  return parsed.toString();
}

/**
 * Photo bytes for a netId, or null when there is no photo to be had.
 *
 * Null covers every failure: no API key, no match, no image on the record, a
 * non-2xx from either hop, an unexpected host, a non-image body, a timeout, and
 * an unreachable host. Callers cannot distinguish them and should not try.
 */
export async function fetchYaliesPhoto(netId: string): Promise<Buffer | null> {
  if (!config.YALIES_API_KEY) return null;

  try {
    const lookup = await fetch(API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.YALIES_API_KEY}`,
      },
      body: JSON.stringify({ filters: { netid: [netId] } }),
      signal: AbortSignal.timeout(YALIES_TIMEOUT_MS),
    });
    if (!lookup.ok) return null;

    const url = photoUrlFrom(await lookup.json());
    if (!url) return null;

    const image = await fetch(url, { signal: AbortSignal.timeout(YALIES_TIMEOUT_MS) });
    if (!image.ok) return null;
    if (!(image.headers.get("content-type") ?? "").startsWith("image/")) return null;

    return Buffer.from(await image.arrayBuffer());
  } catch {
    // Timeout, DNS failure, connection reset, malformed JSON. All are misses.
    return null;
  }
}
